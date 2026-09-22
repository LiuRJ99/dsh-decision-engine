/**
 * The bounded execution runtime: observe → decide → map → execute → verify,
 * once, twice, or until a budget says stop.
 *
 * There is no `while (true)` here. Every loop is bounded by `maxSteps`, by
 * `maxDurationMs`, and by the caller's abort signal, and it stops early on the
 * conditions a fast decision loop must never ignore:
 *
 * - the provider cannot answer or is not confident enough,
 * - the decision names something the environment cannot do,
 * - the action fails to execute,
 * - the environment state stops changing (`no_progress`),
 * - the same action keeps winning (`repeated_decision`),
 * - the environment's structured state becomes unusable (`insufficient_observation`).
 *
 * Every one of those returns the single {@link EscalationResult} shape so the
 * main agent always learns the same thing: hand this back to me.
 *
 * @module dsh-decision-engine/runtime/runner
 */

import type { DecisionEngine } from '../core/decision-engine.ts'
import { DecisionError, toDecisionFailure, toEscalation, type DecisionErrorCode, type EscalationResult } from '../core/errors.ts'
import type { DecisionTelemetrySink, DecisionTimings } from '../core/telemetry.ts'
import type { DecisionMode, DecisionResult } from '../core/types.ts'
import type { ActionResult, EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, Observation } from '../environments/types.ts'
import type { EnvironmentRegistry } from '../environments/registry.ts'

/** How far the runtime is promoted. Nothing runs loops in `decision-only`. */
export type ExecutionMode = 'decision-only' | 'single-step' | 'bounded-loop'

/** Runtime budgets and stop conditions. */
export interface RuntimeConfig {
  /** Hard step cap for one run. Defaults to 10. */
  maxSteps: number
  /** Hard wall-clock cap for one run, in milliseconds. Defaults to 120000. */
  maxDurationMs: number
  /** Confidence floor for acting. `0` accepts any confidence the provider gives. */
  confidenceThreshold: number
  /** How many consecutive steps without a state change trigger `no_progress`. Defaults to 3. */
  noProgressLimit: number
  /** How many times the same action may be chosen in a row before `repeated_decision`. Defaults to 3. */
  repeatedDecisionLimit: number
  /** Per-observation budget in milliseconds. */
  observeTimeoutMs: number
  /** Per-action budget in milliseconds. */
  executeTimeoutMs: number
  /** Milliseconds to wait between steps, so a page or app can settle. Defaults to 0. */
  stepDelayMs: number
  /**
   * Maximum characters of the state considered when fingerprinting for
   * progress detection. Bounds memory and keeps the fingerprint cheap.
   */
  stateFingerprintChars: number
}

/** Partial runtime config as supplied by a caller; missing fields take defaults. */
export type RuntimeConfigInput = Partial<RuntimeConfig>

/** Fully resolved configuration. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  maxSteps: 10,
  maxDurationMs: 120_000,
  confidenceThreshold: 0.55,
  noProgressLimit: 3,
  repeatedDecisionLimit: 3,
  observeTimeoutMs: 90_000,
  executeTimeoutMs: 90_000,
  stepDelayMs: 0,
  stateFingerprintChars: 2_000,
}

/** What one step of the loop produced. */
export interface StepRecord {
  /** 0-based step index. */
  index: number
  decision: DecisionResult
  action: EnvironmentAction
  execution?: ActionResult
  /** Whether the action was executed (false in `decision-only` mode). */
  executed: boolean
  timings: DecisionTimings
}

/** Outcome of one runtime invocation. */
export interface RuntimeOutcome {
  status: 'decided' | 'executed' | 'done' | 'needs_escalation'
  environment: string
  steps: number
  /** Index of the step a caller confirming a single-step action should approve. */
  stepIndex?: number
  decision?: DecisionResult
  action?: EnvironmentAction
  execution?: ActionResult
  /**
   * `needs_escalation` only: the same object callers get as a tool result, so a
   * caller never has to translate.
   */
  escalation?: EscalationResult
  /** Reason for a non-`needs_escalation` early stop (`done` via the adapter's own check). */
  stopReason?: string
}

/** Options for one {@link DecisionRuntime.run} call. */
export interface RunOptions {
  /** Environment id, or a pre-resolved adapter. */
  environment: string | EnvironmentAdapter
  /** What the caller wants achieved. */
  objective: Objective
  /** How far to promote execution. Defaults to `decision-only`. */
  mode?: ExecutionMode
  /** Override the runtime's static candidate set. */
  candidates?: Array<{ id: string; description: string; metadata?: Record<string, unknown> }>
  /** Explicit provider for every decision in this run. */
  provider?: string
  /** Capability to request for every decision in this run. */
  decisionMode?: DecisionMode
  /** Per-run budget overrides. */
  config?: RuntimeConfigInput
  /** Cancellation for the whole run. */
  signal?: AbortSignal
  /** Whether risky actions may execute. Defaults to false — a caller must opt in. */
  allowRisky?: boolean
  /** Keep provider debug detail on every result. */
  debug?: boolean
}

/**
 * The runtime. One instance is shareable; per-run state lives in `run()`.
 */
export class DecisionRuntime {
  readonly #engine: DecisionEngine
  readonly #baseConfig: RuntimeConfig
  readonly #now: () => number
  readonly #environments: EnvironmentRegistry | undefined

  constructor(
    engine: DecisionEngine,
    options: { config?: RuntimeConfigInput; telemetry?: DecisionTelemetrySink; now?: () => number; environments?: EnvironmentRegistry } = {},
  ) {
    this.#engine = engine
    this.#baseConfig = { ...DEFAULT_RUNTIME_CONFIG, ...options.config }
    // `telemetry` is accepted for composition symmetry but step records come
    // from the engine (see EngineDecideOptions.step), so a run emits exactly one
    // record per step instead of two.
    void options.telemetry
    this.#now = options.now ?? (() => performance.now())
    this.#environments = options.environments
  }

  /** The effective config for a run, given per-run overrides. */
  resolveConfig(overrides?: RuntimeConfigInput): RuntimeConfig {
    return { ...this.#baseConfig, ...overrides }
  }

  /**
   * Run the loop.
   *
   * @param options - environment, objective, promotion mode, budgets.
   * @returns an outcome whose `status` is one of `decided`, `executed`, `done`, `needs_escalation`.
   *          Infrastructure failures (unknown environment, invalid request) throw a
   *          {@link DecisionError}; runtime *decisions to stop* return `needs_escalation`.
   */
  async run(options: RunOptions): Promise<RuntimeOutcome> {
    const config = this.resolveConfig(options.config)
    const adapter = this.#resolveAdapter(options.environment)
    const mode = options.mode ?? 'decision-only'
    const startedAt = this.#now()
    const objective = options.objective

    const history: StepRecord[] = []
    let stateFingerprint: string | undefined
    let unchangedStreak = 0
    let repeatedStreak = 0
    let lastSelected: string | undefined
    let lastDecision: DecisionResult | undefined
    let lastProviderId: string | undefined
    // The decide call happens before mapping and execution, so each step's
    // record carries the *previous* step's map/execute cost. That is what makes
    // "which layer is slow" answerable from the records alone.
    let previousMapMs: number | undefined
    let previousExecuteMs: number | undefined

    const escalate = (reason: DecisionErrorCode, details?: Record<string, unknown>, guidance?: string): RuntimeOutcome => {
      const failure = { code: reason, message: typeof details?.message === 'string' ? details.message : reason }
      const escalation = toEscalation(failure, {
        environment: adapter.id,
        ...lastProviderId === undefined ? {} : { provider: lastProviderId },
        ...lastDecision === undefined
          ? {}
          : {
              lastDecision: {
                ...lastDecision.selected === undefined ? {} : { selected: lastDecision.selected },
                ...lastDecision.confidence === undefined ? {} : { confidence: lastDecision.confidence },
                step: history.length,
              },
            },
        ...guidance === undefined ? {} : { guidance },
        ...details === undefined ? {} : { details: { ...details, steps: history.length } },
      })
      return { status: 'needs_escalation', environment: adapter.id, steps: history.length, escalation }
    }

    const maxSteps = mode === 'decision-only' ? 1 : mode === 'single-step' ? Math.min(1, config.maxSteps) : config.maxSteps

    for (let step = 0; step < maxSteps; step += 1) {
      if (options.signal?.aborted === true) return escalate('aborted', { message: 'The run was aborted by the caller.' })
      if (this.#now() - startedAt > config.maxDurationMs) {
        return escalate('budget_exhausted', { maxDurationMs: config.maxDurationMs })
      }

      // ---- observe ----
      const observeStarted = this.#now()
      let observation: Observation
      try {
        observation = await adapter.observe({
          ...options.signal === undefined ? {} : { signal: options.signal },
          timeoutMs: config.observeTimeoutMs,
          objective,
        })
      } catch (error) {
        const failure = toDecisionFailure(error, 'internal')
        return escalate(failure.code === 'internal' ? 'internal' : failure.code, { message: failure.message })
      }
      const observeMs = this.#now() - observeStarted
      if (observation.status !== 'ok') {
        const reason: DecisionErrorCode = observation.status === 'insufficient'
          ? 'insufficient_observation'
          : observation.status === 'unsupported'
            ? 'environment_unsupported'
            : 'environment_unavailable'
        return escalate(reason, {
          message: observation.reason ?? `Environment "${adapter.id}" reported ${observation.status}.`,
          observationStatus: observation.status,
          ...observation.metadata === undefined ? {} : { observation: observation.metadata },
        }, observation.status === 'insufficient'
          ? 'The environment cannot express this task with structured state; use the main agent instead of guessing.'
          : undefined)
      }

      // ---- build request ----
      let request
      try {
        request = await adapter.buildDecisionRequest(observation, objective)
      } catch (error) {
        const failure = toDecisionFailure(error, 'internal')
        return escalate(failure.code, { message: failure.message })
      }
      if (options.candidates !== undefined) request = { ...request, candidates: options.candidates }
      if (options.provider !== undefined) request = { ...request, provider: options.provider }
      if (options.decisionMode !== undefined) request = { ...request, mode: options.decisionMode }
      request = {
        ...request,
        metadata: { ...request.metadata, environment: adapter.id, step },
      }

      // ---- decide ----
      let decision: DecisionResult
      try {
        decision = await this.#engine.decide(request, {
          ...options.provider === undefined ? {} : { provider: options.provider },
          ...options.signal === undefined ? {} : { signal: options.signal },
          debug: options.debug === true,
          environment: adapter.id,
          step,
          // Layers the runtime already measured, so the emitted record carries
          // the environment's cost and the model's cost separately.
          sourceTimings: {
            observeMs,
            ...previousMapMs === undefined ? {} : { mapMs: previousMapMs },
            ...previousExecuteMs === undefined ? {} : { executeMs: previousExecuteMs },
          },
          confidenceThreshold: config.confidenceThreshold,
        })
      } catch (error) {
        const failure = toDecisionFailure(error)
        const reason = failure.code === 'unknown_candidate' ? 'unknown_candidate' : failure.code
        return escalate(reason, {
          message: failure.message,
          ...failure.details === undefined ? {} : { decision: failure.details },
          candidateCount: request.candidates.length,
        })
      }
      lastDecision = decision
      lastProviderId = decision.provider

      // ---- done check (before acting, so a satisfied objective costs nothing) ----
      if (typeof adapter.isDone === 'function') {
        let done: boolean
        try {
          done = await adapter.isDone(observation, objective)
        } catch {
          done = false
        }
        if (done) {
          return {
            status: 'done',
            environment: adapter.id,
            steps: step + 1,
            stepIndex: step,
            decision,
            stopReason: 'The environment reports the objective is already met.',
          }
        }
      }

      // ---- map ----
      const mapStarted = this.#now()
      let action: EnvironmentAction
      try {
        action = await adapter.mapDecision(decision, observation)
      } catch (error) {
        const failure = toDecisionFailure(error, 'action_mapping_failed')
        return escalate(failure.code, { message: failure.message, selected: decision.selected })
      }
      const mapMs = this.#now() - mapStarted

      const timings: DecisionTimings = {
        observeMs,
        decisionMs: decision.latencyMs,
        mapMs,
        totalMs: this.#now() - startedAt,
      }

      if (mode === 'decision-only') {
        return {
          status: 'decided',
          environment: adapter.id,
          steps: 1,
          stepIndex: 0,
          decision,
          action,
          stopReason: 'Decision-only mode: nothing was executed.',
        }
      }

      if (action.risky === true && options.allowRisky !== true) {
        return escalate('high_risk_action', {
          message: `Action "${action.candidateId}" is marked risky; refusing to execute it without confirmation.`,
          action: { kind: action.kind, candidateId: action.candidateId, description: action.description },
        })
      }

      // ---- execute ----
      const executeStarted = this.#now()
      let execution: ActionResult
      try {
        const executeInput: ExecuteInput = {
          ...options.signal === undefined ? {} : { signal: options.signal },
          timeoutMs: config.executeTimeoutMs,
          allowRisky: options.allowRisky === true,
        }
        execution = await adapter.execute(action, executeInput)
      } catch (error) {
        const failure = toDecisionFailure(error, 'action_execution_failed')
        return escalate(failure.code, { message: failure.message, action: { kind: action.kind, candidateId: action.candidateId } })
      }
      const executeMs = this.#now() - executeStarted
      timings.executeMs = executeMs
      timings.totalMs = this.#now() - startedAt
      previousMapMs = mapMs
      previousExecuteMs = executeMs

      const record: StepRecord = {
        index: step,
        decision,
        action,
        execution,
        executed: true,
        timings,
      }
      history.push(record)

      if (execution.ok !== true) {
        return escalate('action_execution_failed', {
          message: execution.message ?? `Action "${action.candidateId}" reported failure.`,
          action: { kind: action.kind, candidateId: action.candidateId },
        })
      }
      if (mode === 'single-step') {
        return {
          status: 'executed',
          environment: adapter.id,
          steps: 1,
          stepIndex: 0,
          decision,
          action,
          execution,
          stopReason: 'Single-step mode: exactly one action was executed.',
        }
      }

      // ---- verify (progress detection) ----
      const nextObservation = await this.#safeObserve(adapter, options.signal, config.observeTimeoutMs, objective)
      if (nextObservation.status !== 'ok') {
        return escalate('insufficient_observation', {
          message: nextObservation.reason ?? 'The environment stopped producing usable structured state.',
          afterStep: step,
        })
      }
      if (typeof adapter.isDone === 'function') {
        let done: boolean
        try {
          done = await adapter.isDone(nextObservation, objective)
        } catch {
          done = false
        }
        if (done || execution.done === true) {
          return {
            status: 'done',
            environment: adapter.id,
            steps: step + 1,
            stepIndex: step,
            decision,
            action,
            execution,
            stopReason: 'The environment reports the objective is met.',
          }
        }
      } else if (execution.done === true) {
        return {
          status: 'done',
          environment: adapter.id,
          steps: step + 1,
          stepIndex: step,
          decision,
          action,
          execution,
          stopReason: 'The environment reports the objective is met.',
        }
      }

      const fingerprint = fingerprintState(nextObservation.state, config.stateFingerprintChars)
      if (fingerprint !== undefined && fingerprint === stateFingerprint) {
        unchangedStreak += 1
        if (unchangedStreak >= config.noProgressLimit) {
          return escalate('no_progress', {
            message: `The environment state did not change for ${unchangedStreak} consecutive steps.`,
            noProgressLimit: config.noProgressLimit,
          })
        }
      } else {
        unchangedStreak = 0
      }
      if (fingerprint !== undefined) stateFingerprint = fingerprint

      const selected = decision.selected
      if (selected !== undefined && selected === lastSelected) {
        repeatedStreak += 1
        if (repeatedStreak >= config.repeatedDecisionLimit) {
          return escalate('repeated_decision', {
            message: `The same candidate "${selected}" was chosen ${repeatedStreak + 1} times in a row.`,
            repeatedDecisionLimit: config.repeatedDecisionLimit,
            selected,
          })
        }
      } else {
        repeatedStreak = 0
      }
      lastSelected = selected

      if (config.stepDelayMs > 0) await abortableSleep(config.stepDelayMs, options.signal)
    }

    return escalate('budget_exhausted', {
      message: `The run reached its ${maxSteps}-step budget without meeting the objective.`,
      maxSteps,
    })
  }

  #resolveAdapter(environment: string | EnvironmentAdapter): EnvironmentAdapter {
    if (typeof environment !== 'string') return environment
    if (this.#environments === undefined) {
      throw new DecisionError('environment_unknown', `Environment "${environment}" cannot be resolved: this runtime has no environment registry.`, {
        subject: environment,
      })
    }
    return this.#environments.require(environment)
  }

  async #safeObserve(adapter: EnvironmentAdapter, signal: AbortSignal | undefined, timeoutMs: number, objective: Objective): Promise<Observation> {
    try {
      return await adapter.observe({
        ...signal === undefined ? {} : { signal },
        timeoutMs,
        objective,
      })
    } catch (error) {
      const failure = toDecisionFailure(error, 'internal')
      return { status: 'error', source: adapter.source, reason: failure.message }
    }
  }

}

/**
 * A cheap, bounded fingerprint of an environment state, used only to detect
 * "nothing changed". It is never persisted and never sent to a model.
 *
 * @returns undefined when the state cannot be fingerprinted (null/undefined).
 */
export function fingerprintState(state: unknown, limit: number): string | undefined {
  if (state === undefined || state === null) return undefined
  if (typeof state === 'string') return state.length > limit ? state.slice(0, limit) : state
  try {
    const json = JSON.stringify(state)
    if (json === undefined) return undefined
    return json.length > limit ? json.slice(0, limit) : json
  } catch {
    return undefined
  }
}

/** Sleep that settles early when the signal aborts. Never rejects. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
