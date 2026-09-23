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
import { DecisionError, toDecisionFailure, toEscalation, type EscalationResult } from '../core/errors.ts'
import type { DecisionTelemetrySink, DecisionTimings } from '../core/telemetry.ts'
import { randomUUID } from 'node:crypto'
import type { DecisionMode, DecisionResult } from '../core/types.ts'
import type { ActionResult, EnvironmentAction, EnvironmentAdapter, Objective, Observation } from '../environments/types.ts'
import type { EnvironmentRegistry } from '../environments/registry.ts'

/** How far the runtime is promoted. Nothing runs loops in `decision-only`. */
export type ExecutionMode = 'decision-only' | 'single-step' | 'bounded-loop'

/**
 * Runtime budgets and stop conditions.
 *
 * `confidenceThreshold` is the *normalized* floor: it is passed to the engine,
 * which compares it only with `confidenceKind: 'normalized'` results. A
 * provider reporting `provider_raw` or `unavailable` is never gated by it —
 * which is why the Laya provider runs to completion regardless of the
 * entropy-derived number it reports. See `docs` in `providers/laya/shared.ts`
 * for the measurements behind that.
 */
export interface RuntimeConfig {
  /** Hard step cap for one run. Defaults to 10. */
  maxSteps: number
  /** Hard wall-clock cap for one run, in milliseconds. Defaults to 120000. */
  maxDurationMs: number
  /**
   * Confidence floor for acting. Applies only to `confidenceKind: 'normalized'`
   * results; a provider on its own scale is never compared with it.
   */
  confidenceThreshold: number
  /** How many consecutive steps without a state change trigger `no_progress`. Defaults to 3. */
  noProgressLimit: number
  /** Repeat limit; 0 disables it. Task takeover defaults to 0, legacy loops to 3. */
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
  /**
   * What to do when a step offers exactly one candidate. `ask` (the default)
   * keeps the provider in the loop; `execute` takes the step directly, because
   * there is nothing to decide and a small local head cannot answer it at all
   * (Laya's TopK needs k=2 over one class and fails the step). Stage scopes
   * that narrow to a single control are what this policy exists for.
   */
  singleCandidateSteps: 'ask' | 'execute'
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
  singleCandidateSteps: 'ask',
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
  /** Last observed state and environment-reported score/outcome. */
  finalState?: unknown
  result?: Record<string, unknown>
  /** Progress through the caller's plan; no intermediate main-agent turn. */
  completedPlanSteps?: string[]
  activePlanStep?: string
}

/** A main-agent-planned stage. The executor chooses actions within this stage. */
export interface TaskPlanStep {
  id: string
  objective: string
  completion: NonNullable<Objective['completion']>
  /** Optional action limit for this stage, within the overall task budget. */
  maxSteps?: number
  /**
   * What the driver may do while this stage is active.
   *
   * Handed to the environment adapter's `withConfig`, so the meaning of the keys
   * belongs to the adapter: for the browser environment that is
   * `includeNonSemantic`, `candidateSelector` and `maxCandidates`. A stage that
   * narrows its scope removes the wrong choices instead of hoping the model
   * ignores them — an advance step offering nothing but the navigation control
   * cannot be answered with an answer option.
   */
  scope?: Record<string, unknown>
}

/** Options for one {@link DecisionRuntime.run} call. */
export interface RunOptions {
  /** Environment id, or a pre-resolved adapter. */
  environment: string | EnvironmentAdapter
  /** What the caller wants achieved. */
  objective: Objective
  /** Ordered stages supplied once by the planner; advanced from observed state. */
  plan?: TaskPlanStep[]
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

/** A whole task, executed without returning to the caller between steps. */
export type TaskOptions = Omit<RunOptions, 'mode' | 'candidates'>
export interface TaskOutcome extends RuntimeOutcome {
  taskId: string
  durationMs: number
}

/** Task defaults permit repeated legal moves; finite step/time budgets remain. */
export const DEFAULT_TASK_CONFIG: RuntimeConfigInput = {
  maxSteps: 1000,
  maxDurationMs: 600_000,
  repeatedDecisionLimit: 0,
}

/**
 * The runtime. One instance is shareable; per-run state lives in `run()`.
 */
export class DecisionRuntime {
  readonly #engine: DecisionEngine
  #baseConfig: RuntimeConfig
  readonly #now: () => number
  readonly #environments: EnvironmentRegistry | undefined
  readonly #busy = new Set<string>()

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
   * Replace the base budgets for subsequent runs.
   *
   * Environments are not rebuilt: their adapters hold per-observation state
   * (a browser index inventory, an accessibility merge base) that a live swap
   * would silently invalidate. Environment toggles therefore take effect on the
   * next start, which is what the settings panel reports.
   */
  reconfigure(overrides: RuntimeConfigInput): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || !(key in this.#baseConfig)) continue
      this.#baseConfig[key as keyof RuntimeConfig] = value as never
    }
  }

  /**
   * Run the loop.
   *
   * @param options - environment, objective, promotion mode, budgets.
   * @returns an outcome whose `status` is one of `decided`, `executed`, `done`, `needs_escalation`.
   *          Infrastructure failures (unknown environment, invalid request) throw a
   *          {@link DecisionError}; runtime *decisions to stop* return `needs_escalation`.
   */
  async runTask(options: TaskOptions): Promise<TaskOutcome> {
    const adapter = this.#resolveAdapter(options.environment)
    if ((adapter.source === 'browser' || adapter.source === 'computer') && adapter.isDone === undefined && options.objective.completion === undefined && !options.plan?.length) {
      throw new DecisionError('invalid_request', 'A whole browser/desktop task needs a completion rule or an adapter with isDone().')
    }
    const taskId = randomUUID()
    const started = this.#now()
    const outcome = await this.run({
      ...options,
      mode: 'bounded-loop',
      config: { ...DEFAULT_TASK_CONFIG, ...options.config },
    })
    return { ...outcome, taskId, durationMs: this.#now() - started }
  }

  async run(options: RunOptions): Promise<RuntimeOutcome> {
    const config = this.resolveConfig(options.config)
    validateRuntimeConfig(config)
    validateCompletion(options.objective.completion)
    validatePlan(options.plan)
    const adapter = this.#resolveAdapter(options.environment)
    if (this.#busy.has(adapter.id)) {
      throw new DecisionError('environment_unavailable', `Environment "${adapter.id}" already has an active or draining run.`)
    }
    this.#busy.add(adapter.id)
    const pending = new Set<Promise<unknown>>()
    try {
      return await this.#drive(options, config, adapter, pending)
    } finally {
      // A timed-out executor might still be applying an action. Keep the lease
      // until outstanding work settles instead of allowing overlapping control.
      if (pending.size === 0) this.#busy.delete(adapter.id)
      else void Promise.allSettled([...pending]).then(() => this.#busy.delete(adapter.id))
    }
  }

  async #drive(options: RunOptions, config: RuntimeConfig, adapter: EnvironmentAdapter, pending: Set<Promise<unknown>>): Promise<RuntimeOutcome> {
    const startedAt = this.#now()
    const mode = options.mode ?? 'decision-only'
    if (!['decision-only', 'single-step', 'bounded-loop'].includes(mode)) throw new DecisionError('invalid_request', 'Unknown execution mode.')
    const objective = options.objective
    const plan = options.plan
    let planIndex = 0
    let planStartedAtStep = 0
    let steps = 0
    let lastObservation: Observation | undefined
    let lastDecision: DecisionResult | undefined
    let lastAction: EnvironmentAction | undefined
    let lastExecution: ActionResult | undefined
    let unchangedStreak = 0
    let repeatedStreak = 0
    let lastSelected: string | undefined
    let previousMapMs: number | undefined
    let previousExecuteMs: number | undefined

    const check = (): number => {
      if (options.signal?.aborted) throw new DecisionError('aborted', 'The run was aborted by the caller.')
      const remaining = config.maxDurationMs - (this.#now() - startedAt)
      if (remaining <= 0) throw new DecisionError('budget_exhausted', 'The task duration budget was exhausted.')
      return remaining
    }
    const phase = async <T>(name: string, limit: number, work: (signal: AbortSignal, timeoutMs: number) => Promise<T> | T): Promise<T> => {
      const ms = Math.min(limit, check())
      const controller = new AbortController()
      let rejectStop: (reason: unknown) => void = () => undefined
      const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject })
      const stop = (error: DecisionError): void => {
        rejectStop(error)
        controller.abort(error)
      }
      const phaseDetails = { phase: name, ...name === 'execute' ? { actionMayHaveExecuted: true } : {} }
      const onAbort = (): void => stop(new DecisionError('aborted', `Cancelled during ${name}.`, { details: phaseDetails }))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => stop(new DecisionError('budget_exhausted', `${name} exceeded its ${ms}ms budget.`, { details: phaseDetails })), ms)
      const active = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return work(controller.signal, ms)
      })
      pending.add(active)
      void active.then(() => pending.delete(active), () => pending.delete(active))
      try {
        const value = await Promise.race([active, stopped])
        check()
        return value
      } catch (error) {
        if (error instanceof DecisionError) throw error
        const fallback = name === 'execute' ? 'action_execution_failed' : name === 'map action' ? 'action_mapping_failed' : 'internal'
        const failure = toDecisionFailure(error, fallback)
        throw new DecisionError(failure.code, failure.message, { cause: error, details: phaseDetails })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
    }
    // A stage may narrow what the driver is allowed to do. The adapter owns the
    // meaning of a scope; an environment without `withConfig` ignores it, and a
    // stage without a scope falls back to the adapter the caller registered.
    let activeAdapter = adapter
    let appliedStage: string | undefined
    const applyStageScope = (stage: TaskPlanStep | undefined): void => {
      const key = stage?.id ?? ''
      if (key === appliedStage) return
      appliedStage = key
      activeAdapter = stage?.scope === undefined || typeof adapter.withConfig !== 'function'
        ? adapter
        : adapter.withConfig(stage.scope)
    }
    applyStageScope(plan?.[planIndex])
    const observe = (): Promise<Observation> => phase('observe', config.observeTimeoutMs,
      (signal, timeoutMs) => activeAdapter.observe({ signal, timeoutMs, objective }))
    const assertObservation = (observation: Observation): void => {
      if (observation.status === 'ok') return
      throw new DecisionError(observation.status === 'insufficient' ? 'insufficient_observation'
        : observation.status === 'unsupported' ? 'environment_unsupported' : 'environment_unavailable',
      observation.reason ?? `Environment "${adapter.id}" returned ${observation.status}.`)
    }
    // Progress is judged on what the adapter calls progress — for a browser that
    // is the page's meaning, not its element numbering.
    const progressKey = (state: unknown): unknown =>
      typeof activeAdapter.progressKey === 'function' ? activeAdapter.progressKey(state) : state
    const isDone = (observation: Observation): Promise<boolean> => phase('completion check', config.observeTimeoutMs, async () =>
      observation.done === true || completionMatches(observation.state, objective.completion)
      || (await activeAdapter.isDone?.(observation, objective)) === true)
    const checkCompletion = async (observation: Observation): Promise<boolean> => {
      // Stage transitions use the planner's explicit predicates. The small
      // model chooses actions; it cannot silently rewrite or skip the plan.
      if (plan !== undefined) {
        while (planIndex < plan.length && completionMatches(observation.state, plan[planIndex]!.completion)) {
          planIndex++
          planStartedAtStep = steps
        }
        applyStageScope(plan[planIndex])
        if (planIndex === plan.length) return true
      }
      return isDone(observation)
    }
    const outcome = (status: RuntimeOutcome['status'], stopReason: string): RuntimeOutcome => ({
      status, environment: adapter.id, steps, stopReason,
      ...steps === 0 ? {} : { stepIndex: steps - 1 },
      ...lastDecision === undefined ? {} : { decision: lastDecision },
      ...lastAction === undefined ? {} : { action: lastAction },
      ...lastExecution === undefined ? {} : { execution: lastExecution },
      ...lastObservation?.state === undefined ? {} : { finalState: lastObservation.state },
      ...(lastObservation?.result ?? lastExecution?.result) === undefined ? {}
        : { result: (lastObservation?.result ?? lastExecution?.result)! },
      ...plan === undefined ? {} : {
        completedPlanSteps: plan.slice(0, planIndex).map(stage => stage.id),
        ...plan[planIndex] === undefined ? {} : { activePlanStep: plan[planIndex]!.id },
      },
    })

    try {
      const observeStarted = this.#now()
      lastObservation = await observe()
      let observeMs = this.#now() - observeStarted
      assertObservation(lastObservation)
      const maxSteps = mode === 'bounded-loop' ? config.maxSteps : 1
      for (let step = 0; step < maxSteps; step += 1) {
        check()
        // Terminal states often offer no actions. Never require a model to
        // answer another question before recognizing an already-finished task.
        if (await checkCompletion(lastObservation)) return outcome('done', 'The environment is terminal or the configured completion conditions are met.')
        const stage = plan?.[planIndex]
        if (stage?.maxSteps !== undefined && steps - planStartedAtStep >= stage.maxSteps) {
          throw new DecisionError('budget_exhausted', `Plan step "${stage.id}" reached its ${stage.maxSteps}-action budget.`)
        }
        const stepObjective = stage === undefined ? objective : {
          ...objective,
          description: `Current plan step (${stage.id}): ${stage.objective}\nOverall task: ${objective.description}`,
        }
        let request = await phase('build request', config.observeTimeoutMs, () => activeAdapter.buildDecisionRequest(lastObservation!, stepObjective))
        if (options.candidates !== undefined) request = { ...request, candidates: options.candidates }
        if (options.provider !== undefined) request = { ...request, provider: options.provider }
        if (options.decisionMode !== undefined) request = { ...request, mode: options.decisionMode }
        request = { ...request, metadata: { ...request.metadata, environment: adapter.id, step } }
        // A choice set of one is not a choice: executing it needs no provider.
        // Asking anyway is not merely wasteful — a small local head cannot
        // answer it (Laya's TopK needs k=2 over a single class and fails the
        // step with `provider_failed`), and a narrow stage scope deliberately
        // produces such sets. Providers stay in the loop for real decisions.
        const offered = request.candidates ?? []
        lastDecision = config.singleCandidateSteps === 'execute' && offered.length === 1
          ? { provider: 'single-candidate', mode: request.mode ?? 'choice', selected: offered[0]!.id, latencyMs: 0 }
          : await phase('decide', check(), (signal, timeoutMs) => this.#engine.decide(request, {
          signal, timeoutMs: Math.min(timeoutMs, this.#engine.timeoutMs), debug: options.debug === true, environment: adapter.id, step,
          confidenceThreshold: config.confidenceThreshold,
          sourceTimings: {
            observeMs,
            ...previousMapMs === undefined ? {} : { mapMs: previousMapMs },
            ...previousExecuteMs === undefined ? {} : { executeMs: previousExecuteMs },
          },
        }))
        const mapStarted = this.#now()
        lastAction = await phase('map action', config.executeTimeoutMs, () => activeAdapter.mapDecision(lastDecision!, lastObservation!))
        previousMapMs = this.#now() - mapStarted
        if (mode === 'decision-only') return { ...outcome('decided', 'Decision-only mode: nothing was executed.'), steps: 1, stepIndex: 0 }
        if (lastAction.risky && options.allowRisky !== true) throw new DecisionError('high_risk_action', `Action "${lastAction.candidateId}" requires confirmation.`)
        const before = fingerprintState(progressKey(lastObservation.state), config.stateFingerprintChars)
        const executeStarted = this.#now()
        check()
        lastExecution = await phase('execute', config.executeTimeoutMs, (signal, timeoutMs) => activeAdapter.execute(lastAction!, {
          signal, timeoutMs, allowRisky: options.allowRisky === true,
        }))
        steps += 1
        previousExecuteMs = this.#now() - executeStarted
        if (!lastExecution.ok) throw new DecisionError('action_execution_failed', lastExecution.message ?? 'The environment refused the action.')
        if (lastExecution.observation !== undefined) lastObservation = lastExecution.observation
        else if (lastExecution.done === true) lastObservation = {
          status: 'ok', source: adapter.source, done: true,
          ...lastExecution.state === undefined ? {} : { state: lastExecution.state },
          ...lastExecution.result === undefined ? {} : { result: lastExecution.result },
        }
        if (mode === 'single-step') return outcome('executed', 'Single-step mode: exactly one action was executed.')
        if (lastExecution.done === true) {
          assertObservation(lastObservation)
          await checkCompletion(lastObservation)
          return outcome('done', 'The environment reports a terminal result.')
        }
        if (config.stepDelayMs > 0) await phase('settle', check(), signal => abortableSleep(config.stepDelayMs, signal))
        const verifyStarted = this.#now()
        if (lastExecution.observation === undefined) lastObservation = await observe()
        observeMs = this.#now() - verifyStarted
        assertObservation(lastObservation)
        if (await checkCompletion(lastObservation)) return outcome('done', 'The environment is terminal or the configured completion conditions are met.')
        const after = fingerprintState(progressKey(lastObservation.state), config.stateFingerprintChars)
        unchangedStreak = after !== undefined && after === before ? unchangedStreak + 1 : 0
        if (config.noProgressLimit > 0 && unchangedStreak >= config.noProgressLimit) throw new DecisionError('no_progress', `The state did not change for ${unchangedStreak} actions.`)
        repeatedStreak = lastDecision.selected === lastSelected ? repeatedStreak + 1 : 0
        lastSelected = lastDecision.selected
        if (config.repeatedDecisionLimit > 0 && repeatedStreak >= config.repeatedDecisionLimit) throw new DecisionError('repeated_decision', `The same candidate was chosen ${repeatedStreak + 1} times.`)
      }
      throw new DecisionError('budget_exhausted', `The run reached its ${maxSteps}-step budget without completing.`)
    } catch (error) {
      const failure = toDecisionFailure(error, 'internal')
      return {
        ...outcome('needs_escalation', failure.message),
        escalation: toEscalation(failure, {
          environment: adapter.id,
          ...lastDecision === undefined ? {} : { provider: lastDecision.provider, lastDecision: {
            ...lastDecision.selected === undefined ? {} : { selected: lastDecision.selected },
            ...lastDecision.confidence === undefined ? {} : { confidence: lastDecision.confidence },
            ...lastDecision.confidenceKind === undefined ? {} : { confidenceKind: lastDecision.confidenceKind },
            step: steps,
          } },
          details: { ...failure.details, message: failure.message, steps },
        }),
      }
    }
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

/** Validate budgets at the public boundary, including non-DSH callers. */
export function validateRuntimeConfig(config: RuntimeConfig): void {
  for (const key of ['maxSteps', 'maxDurationMs', 'observeTimeoutMs', 'executeTimeoutMs', 'stateFingerprintChars'] as const) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new DecisionError('invalid_request', `${key} must be finite and positive.`)
  }
  if (config.singleCandidateSteps !== 'ask' && config.singleCandidateSteps !== 'execute') {
    throw new DecisionError('invalid_request', 'singleCandidateSteps must be "ask" or "execute".')
  }
  for (const key of ['noProgressLimit', 'repeatedDecisionLimit', 'stepDelayMs'] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw new DecisionError('invalid_request', `${key} must be finite and non-negative.`)
  }
  if (!Number.isInteger(config.maxSteps)) throw new DecisionError('invalid_request', 'maxSteps must be an integer.')
  if (!Number.isFinite(config.confidenceThreshold) || config.confidenceThreshold < 0 || config.confidenceThreshold > 1) throw new DecisionError('invalid_request', 'confidenceThreshold must be between 0 and 1.')
}

export function validateCompletion(rule: Objective['completion']): void {
  if (rule === undefined) return
  if (rule === null || typeof rule !== 'object' || typeof rule.path !== 'string' || rule.path.trim() === '' || (rule.equals === undefined) === (rule.includes === undefined)
    || (rule.includes !== undefined && (typeof rule.includes !== 'string' || rule.includes === ''))
    || (rule.equals !== undefined && !['string', 'number', 'boolean'].includes(typeof rule.equals))) {
    throw new DecisionError('invalid_request', 'completion needs a path and exactly one of equals/includes.')
  }
}

function validatePlan(plan: TaskPlanStep[] | undefined): void {
  if (plan === undefined) return
  if (!Array.isArray(plan) || plan.length === 0 || plan.length > 64) throw new DecisionError('invalid_request', 'A plan must contain between 1 and 64 stages.')
  const ids = new Set<string>()
  for (const stage of plan) {
    if (stage === null || typeof stage !== 'object' || typeof stage.id !== 'string' || stage.id.trim() === '' || ids.has(stage.id)
      || typeof stage.objective !== 'string' || stage.objective.trim() === ''
      || stage.completion === undefined
      || (stage.maxSteps !== undefined && (!Number.isInteger(stage.maxSteps) || stage.maxSteps <= 0))
      || (stage.scope !== undefined && (stage.scope === null || typeof stage.scope !== 'object' || Array.isArray(stage.scope)))) {
      throw new DecisionError('invalid_request', 'Each plan stage needs a unique id, an objective, a completion rule, and an optional positive integer maxSteps; scope, when present, must be an object.')
    }
    ids.add(stage.id)
    validateCompletion(stage.completion)
  }
}

function completionMatches(state: unknown, rule: Objective['completion']): boolean {
  if (rule === undefined) return false
  let value = state
  for (const key of rule.path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return false
    value = (value as Record<string, unknown>)[key]
  }
  return rule.includes === undefined ? value === rule.equals : typeof value === 'string' && value.includes(rule.includes)
}
