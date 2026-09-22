/**
 * Pure decision-tool logic: arguments, preflight, projections, and rendering.
 *
 * Nothing here imports the host: the tool's contract can be tested without a
 * DSH process, and `decision-decide.ts` adds the `defineTool` wrapper on top.
 *
 * One tool, not a family. It covers all three promotion levels through its
 * arguments:
 *
 * - decision only (the default): observe, decide, map, and return a preview;
 * - `execute: true`: run exactly one mapped action and return the result;
 * - `execute: "loop"` (with `environment`): run the bounded loop.
 *
 * What the tool deliberately does not do: expose a provider's raw output as
 * protocol, let a provider name a tool, or widen a capability. Every
 * environment action goes back through the same tool registry the session's
 * capability gate already governs, so the decision layer cannot authorize
 * anything the user has not.
 *
 * @module dsh-decision-engine/tools/decide-logic
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { toDecisionFailure } from '../core/errors.ts'
import { validateRequest } from '../core/validate.ts'
import type { DecisionMode } from '../core/types.ts'
import type { EnvironmentAction, Objective } from '../environments/types.ts'
import type { ExecutionMode, RuntimeOutcome } from '../runtime/runner.ts'
import { DecisionError } from '../core/errors.ts'
import type { DecisionEngineService } from '../service.ts'
import { GATE_SKILL_NAMES } from '../gate.ts'

/** Lossless-JSON object, matching what the tool output schema can carry. */
type JsonObject = Record<string, JsonValue>

/** One candidate as the tool accepts it. */
export interface DecideCandidateInput {
  id: string
  description: string
  metadata?: Record<string, unknown>
}

/** The tool's arguments. */
export interface DecideToolInput {
  /** What the caller wants achieved. */
  objective?: string
  /** Environment state: a string, or a structured object. */
  state?: string | Record<string, unknown>
  /** Finite candidate set. Required unless an environment derives one. */
  candidates?: DecideCandidateInput[]
  /** Required capability. Defaults to `choice`. */
  mode?: DecisionMode
  /** Explicit provider id. Omitted routes to the default provider. */
  provider?: string
  /** Hard constraints the decision must respect. */
  constraints?: string[]
  /** Environment id (`browser`, `computer`, or a registered custom environment). */
  environment?: string
  /** `false`/omitted = decision only; `true` = execute one action; `"loop"` = bounded loop. */
  execute?: boolean | 'loop'
  /** Override the runtime's step budget for a loop run. */
  maxSteps?: number
  /** Whether risky actions may execute. Defaults to false. */
  allowRisky?: boolean
  /** Keep provider-private debug detail on the result. */
  debug?: boolean
}

/** The tool's canonical output. */
export interface DecideToolOutput {
  status: 'decided' | 'executed' | 'done' | 'needs_escalation'
  provider?: string
  mode?: DecisionMode
  selected?: string
  candidates?: string[]
  confidence?: number
  latencyMs?: number
  /** Mapped action preview — what the decision means in the environment. */
  action?: {
    kind: string
    candidateId: string
    description: string
    target?: string | number
    risky?: boolean
  }
  executed?: boolean
  executionMessage?: string
  steps?: number
  /** Provider-private detail, present when `debug` was requested. */
  debug?: JsonObject
  /** Guidance for the main agent when the call escalated, or a note when the mode stopped early. */
  guidance?: string
  stopReason?: string
}

/**
 * Coerce a provider's debug payload into lossless JSON.
 *
 * Providers are third-party code: a debug value that is not JSON (a class
 * instance, a function) must not fail an otherwise successful decision, so it
 * is projected rather than validated.
 */
function toJsonObject(value: unknown): JsonObject {
  try {
    const json = JSON.parse(JSON.stringify(value ?? {})) as unknown
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? json as JsonObject : { value: json as JsonValue }
  } catch {
    return { unserializable: true }
  }
}

/** Where the tool's text comes from, abstracted so tests can drive it without a host. */
export interface DecideToolContext {
  service: DecisionEngineService
  /** The calling agent, when the host supplied one. */
  agent?: unknown
}

/** Map the tool's `execute` argument to a runtime execution mode. */
export function executionModeOf(execute: DecideToolInput['execute']): ExecutionMode {
  if (execute === 'loop') return 'bounded-loop'
  if (execute === true) return 'single-step'
  return 'decision-only'
}

/** Build the objective the runtime and the adapters see. */
export function objectiveOf(input: DecideToolInput): Objective {
  const objective: Objective = { description: input.objective ?? '' }
  if (input.constraints !== undefined) objective.constraints = input.constraints
  return objective
}

/**
 * Challenge a call before it runs, so a malformed request never reaches a
 * provider or an environment. Returns a reason string to deny, or undefined.
 */
export function preflightDecideInput(input: DecideToolInput, service: DecisionEngineService): string | undefined {
  const hasEnvironment = typeof input.environment === 'string' && input.environment !== ''
  if (!hasEnvironment) {
    if (input.state === undefined) {
      return 'decision_decide: pass state, or pass environment to observe one.'
    }
    if (input.candidates === undefined || input.candidates.length === 0) {
      return 'decision_decide: pass a non-empty candidates array, or pass environment to derive one.'
    }
    try {
      validateRequest({
        state: input.state,
        candidates: input.candidates.map(candidate => ({ id: candidate.id, description: candidate.description })),
        ...input.mode === undefined ? {} : { mode: input.mode },
        ...input.provider === undefined ? {} : { provider: input.provider },
      })
    } catch (error) {
      const failure = toDecisionFailure(error)
      return `decision_decide: ${failure.message}`
    }
    return undefined
  }

  const environmentId = input.environment ?? ''
  if (!service.environments.has(environmentId)) {
    return `decision_decide: no environment adapter is registered as "${environmentId}" (registered: ${service.environments.ids().join(', ') || 'none'}).`
  }
  if (executionModeOf(input.execute) === 'decision-only') {
    // Decision-only against an environment still needs the environment to be
    // reachable; observe() reports that, so nothing to preflight here.
    return undefined
  }
  const capability = environmentId === 'browser' ? 'browser' : environmentId === 'computer' ? 'computer' : undefined
  if (capability !== undefined && service.isCapabilityUnlocked(capability) === false) {
    return `decision_decide: the ${capability} capability is not authorized in this session. The user must invoke /${GATE_SKILL_NAMES[capability]} first; this tool cannot unlock it.`
  }
  if (input.allowRisky === true) {
    // Allowed, but the runtime still refuses per-action unless the caller opted in.
    return undefined
  }
  return undefined
}

/** The tool's model-facing parameter schema. */
export const PARAMETERS = {
  objective: {
    type: 'string' as const,
    description: 'What the caller is trying to achieve. Prefer naming the concrete next outcome.',
  },
  state: {
    type: 'object' as const,
    additionalProperties: true,
    description: 'Structured environment state to decide about. Omit when environment is given and the adapter should observe.',
  },
  candidates: {
    type: 'array' as const,
    items: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        id: { type: 'string' as const, required: true, description: 'Stable option id the decider may return.' },
        description: { type: 'string' as const, required: true, description: 'What choosing this option does.' },
        metadata: { type: 'object' as const, additionalProperties: true, description: 'Optional structured attributes of the option.' },
      },
    },
    description: 'The finite option set. Required unless environment derives one.',
  },
  mode: {
    type: 'string' as const,
    enum: ['choice', 'ranking', 'score', 'classification'],
    description: 'Required capability. Defaults to choice.',
  },
  provider: {
    type: 'string' as const,
    description: 'Explicit provider id. Omit to use the configured default provider.',
  },
  constraints: {
    type: 'array' as const,
    items: { type: 'string' as const },
    description: 'Hard constraints the decision must respect.',
  },
  environment: {
    type: 'string' as const,
    description: 'Environment id to observe and act in (browser, computer, or a registered custom environment).',
  },
  execute: {
    oneOf: [
      { type: 'boolean' as const },
      { type: 'string' as const, enum: ['loop'] },
    ],
    description: 'Execution level: omitted/false = preview only (default), true = execute exactly one action, "loop" = bounded loop.',
  },
  maxSteps: {
    type: 'number' as const,
    description: 'Step budget override for a loop run.',
  },
  allowRisky: {
    type: 'boolean' as const,
    description: 'Allow externally visible or hard-to-undo actions. Defaults to false.',
  },
  debug: {
    type: 'boolean' as const,
    description: 'Keep provider-private debug detail on the result.',
  },
} as const

/** Project a mapped action onto the tool's output shape. */
export function projectAction(action: EnvironmentAction | undefined): DecideToolOutput['action'] {
  if (action === undefined) return undefined
  return {
    kind: action.kind,
    candidateId: action.candidateId,
    description: action.description,
    ...typeof action.target === 'string' || typeof action.target === 'number' ? { target: action.target } : {},
    ...action.risky === true ? { risky: true } : {},
  }
}

/** Project a runtime outcome onto the tool's output shape. */
export function projectOutcome(outcome: RuntimeOutcome): DecideToolOutput {
  if (outcome.status === 'needs_escalation' && outcome.escalation !== undefined) {
    const escalation = outcome.escalation
    return {
      status: 'needs_escalation',
      steps: outcome.steps,
      guidance: escalation.guidance,
      ...escalation.provider === undefined ? {} : { provider: escalation.provider },
      ...escalation.lastDecision?.selected === undefined ? {} : { selected: escalation.lastDecision.selected },
      ...escalation.lastDecision?.confidence === undefined ? {} : { confidence: escalation.lastDecision.confidence },
      ...escalation.details === undefined ? {} : { debug: toJsonObject(escalation.details) },
    }
  }
  const action = projectAction(outcome.action)
  return {
    status: outcome.status,
    steps: outcome.steps,
    ...outcome.decision === undefined ? {} : {
      provider: outcome.decision.provider,
      mode: outcome.decision.mode,
      latencyMs: outcome.decision.latencyMs,
      ...outcome.decision.selected === undefined ? {} : { selected: outcome.decision.selected },
      ...outcome.decision.confidence === undefined ? {} : { confidence: outcome.decision.confidence },
      ...outcome.decision.debug === undefined ? {} : { debug: toJsonObject(outcome.decision.debug) },
    },
    ...action === undefined ? {} : { action },
    ...outcome.execution === undefined
      ? {}
      : {
          executed: outcome.execution.ok,
          ...outcome.execution.message === undefined ? {} : { executionMessage: outcome.execution.message },
        },
    ...outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason },
  }
}

/** Render the tool's output as the single text block the model reads. */
export function renderDecideOutput(output: DecideToolOutput): string {
  const lines: string[] = []
  if (output.status === 'needs_escalation') {
    lines.push('Escalation: this step needs the main agent.')
    if (output.provider !== undefined) lines.push(`Provider: ${output.provider}`)
    if (output.guidance !== undefined) lines.push(`Guidance: ${output.guidance}`)
    if (output.steps !== undefined) lines.push(`Steps taken: ${output.steps}`)
    if (output.debug !== undefined) lines.push(`Detail: ${JSON.stringify(output.debug)}`)
    return lines.join('\n')
  }
  lines.push(`Status: ${output.status}`)
  if (output.provider !== undefined) lines.push(`Provider: ${output.provider}`)
  if (output.mode !== undefined) lines.push(`Mode: ${output.mode}`)
  if (output.selected !== undefined) lines.push(`Decision: ${output.selected}`)
  if (output.confidence !== undefined) lines.push(`Confidence: ${output.confidence.toFixed(3)}`)
  if (output.latencyMs !== undefined) lines.push(`Provider latency: ${output.latencyMs}ms`)
  if (output.candidates !== undefined && output.candidates.length > 0) lines.push(`Ranked candidates: ${output.candidates.join(' > ')}`)
  if (output.action !== undefined) {
    const target = output.action.target === undefined ? '' : ` target=${String(output.action.target)}`
    lines.push(`Mapped action: ${output.action.kind}${target} — ${output.action.description}${output.action.risky === true ? ' [risky]' : ''}`)
  }
  if (output.executed !== undefined) lines.push(`Executed: ${output.executed ? 'yes' : 'no'}`)
  if (output.executionMessage !== undefined) lines.push(`Environment: ${output.executionMessage}`)
  if (output.steps !== undefined) lines.push(`Steps: ${output.steps}`)
  if (output.stopReason !== undefined) lines.push(`Note: ${output.stopReason}`)
  if (output.debug !== undefined) lines.push(`Debug: ${JSON.stringify(output.debug)}`)
  return lines.join('\n')
}


/**
 * Execute one `decision_decide` call end to end over the composition service.
 *
 * Host-free on purpose: the tool wrapper and the integration tests call this
 * same function, so the tested path is the executed path.
 *
 * @throws DecisionError for a malformed call; a runtime *decision to stop*
 *   comes back as `status: 'needs_escalation'` instead of an error.
 */
export async function executeDecide(input: DecideToolInput, context: DecideToolContext, signal?: AbortSignal): Promise<DecideToolOutput> {
  const { service } = context
  const mode = executionModeOf(input.execute)
  const debug = input.debug === true

  const environmentId = typeof input.environment === 'string' && input.environment !== '' ? input.environment : undefined
  if (environmentId !== undefined) {
    const outcome = await service.run({
      environment: environmentId,
      objective: objectiveOf(input),
      mode,
      ...input.provider === undefined ? {} : { provider: input.provider },
      ...input.candidates === undefined ? {} : { candidates: input.candidates },
      ...input.mode === undefined ? {} : { decisionMode: input.mode },
      ...input.maxSteps === undefined ? {} : { config: { maxSteps: input.maxSteps } },
      ...input.allowRisky === undefined ? {} : { allowRisky: input.allowRisky },
      ...signal === undefined ? {} : { signal },
      debug,
    })
    return projectOutcome(outcome)
  }

  if (input.state === undefined) {
    throw new DecisionError('invalid_request', 'decision_decide needs state or environment.')
  }
  if (input.candidates === undefined || input.candidates.length === 0) {
    throw new DecisionError('no_candidates', 'decision_decide needs a non-empty candidates array when no environment is given.')
  }
  const result = await service.decide({
    ...input.objective === undefined ? {} : { objective: input.objective },
    state: input.state,
    candidates: input.candidates.map(candidate => ({
      id: candidate.id,
      description: candidate.description,
      ...candidate.metadata === undefined ? {} : { metadata: candidate.metadata },
    })),
    ...input.mode === undefined ? {} : { mode: input.mode },
    ...input.provider === undefined ? {} : { provider: input.provider },
    ...input.constraints === undefined ? {} : { constraints: input.constraints },
  }, {
    ...input.provider === undefined ? {} : { provider: input.provider },
    ...signal === undefined ? {} : { signal },
    debug,
  })
  const ranked = (result.ranking ?? []).map(entry => entry.id)
  return {
    status: 'decided',
    provider: result.provider,
    mode: result.mode,
    ...result.selected === undefined ? {} : { selected: result.selected },
    candidates: ranked.length > 0 ? ranked : input.candidates.map(candidate => candidate.id),
    ...result.confidence === undefined ? {} : { confidence: result.confidence },
    latencyMs: result.latencyMs,
    ...result.debug === undefined ? {} : { debug: toJsonObject(result.debug) },
    stopReason: 'Decision only: nothing was executed.',
  }
}
