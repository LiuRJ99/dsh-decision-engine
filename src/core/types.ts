/**
 * Model-agnostic decision protocol: the wire vocabulary every Decision
 * Provider answers in and every Environment Adapter consumes.
 *
 * Nothing in this module names a concrete decision model, a concrete
 * environment, or a concrete tool. A provider is reachable only through
 * {@link DecisionProvider}; an environment is reachable only through
 * `EnvironmentAdapter`. That is what lets a provider be swapped without
 * touching an adapter, and an adapter be added without touching a provider.
 *
 * @module dsh-decision-engine/core/types
 */

/**
 * What a provider can be asked to do. Capabilities are the routing and
 * validation vocabulary — the engine refuses a request whose mode no candidate
 * provider declares, instead of silently degrading a ranking into a choice.
 *
 * `noul` is deliberately absent: it is a private concept of one model family
 * and belongs inside that provider's own translation layer.
 */
export type DecisionCapability = 'choice' | 'ranking' | 'score' | 'classification'

/** Every capability, in canonical order. Useful for config validation and prompts. */
export const DECISION_CAPABILITIES: readonly DecisionCapability[] = [
  'choice',
  'ranking',
  'score',
  'classification',
]

/** Request mode. Structurally identical to a capability; the mode IS the required capability. */
export type DecisionMode = DecisionCapability

/** Whether `value` names a known decision capability. */
export function isDecisionCapability(value: unknown): value is DecisionCapability {
  return typeof value === 'string' && (DECISION_CAPABILITIES as readonly string[]).includes(value)
}

/**
 * One option the decider may pick. The candidate set is supplied by the
 * caller and is finite by contract: a decision provider selects, ranks, or
 * scores these ids and may never invent an id that is not present here.
 */
export interface DecisionCandidate {
  /** Stable id. It must mean the same thing across repeated decisions in one workflow. */
  id: string
  /** Human/model-readable description of what choosing this id does. */
  description: string
  /** Optional structured attributes of the option (cost, risk, target ref, …). */
  metadata?: Record<string, unknown>
}

/**
 * One decision problem: an objective, an observation of state, and a finite
 * candidate set.
 *
 * `state` carries whatever the environment produced — a rendered page
 * snapshot, a serialized accessibility tree, a game-state object. The engine
 * treats it as opaque data; providers that need structure receive it through
 * {@link DecisionRequest.metadata} or a provider-private field.
 */
export interface DecisionRequest {
  /** What the caller is trying to achieve, in natural language. */
  objective?: string
  /** Environment state, verbatim. Never interpreted by the engine. */
  state: string | Record<string, unknown>
  /** The finite option set. */
  candidates: DecisionCandidate[]
  /** Explicit constraints the decider must respect. */
  constraints?: string[]
  /** Required capability; defaults to `choice`. */
  mode?: DecisionMode
  /**
   * Explicit provider id. Omitted means "route by policy" — the engine's
   * configured default. This is the one routing field that belongs on the
   * protocol rather than in `metadata`, because it is part of what the caller
   * is asking for, not a hint about the environment.
   */
  provider?: string
  /** Free-form routing hints and adapter-supplied context (environment id, step index, …). */
  metadata?: Record<string, unknown>
}

/** One ranked entry of a {@link DecisionResult}. */
export interface DecisionRankEntry {
  /** A candidate id from the request. */
  id: string
  /** Provider score for this candidate. Meaningful relative to the same result's other scores. */
  score?: number
}

/**
 * Provider-private raw payload. Kept in a dedicated slot so no consumer can
 * mistake it for protocol, and only attached when the caller asked for debug
 * detail.
 */
export interface DecisionResultDebug {
  /** Provider-specific raw response, verbatim (probabilities, per-question answers, …). */
  raw?: unknown
  /** Provider-specific notes (which rule fired, which fallback ran, …). */
  notes?: string[]
}

/**
 * The normalized answer. Every provider returns this shape regardless of the
 * model behind it.
 */
export interface DecisionResult {
  /** Id of the provider that produced this result. */
  provider: string
  /** Capability that was actually exercised (equals the request mode). */
  mode: DecisionMode
  /** Chosen candidate id — the only field an Action Mapper needs for a single step. */
  selected?: string
  /** Full ordered preference, best first. Always includes every candidate the provider scored. */
  ranking?: DecisionRankEntry[]
  /** Calibrated 0..1 confidence, when the provider can produce one. */
  confidence?: number
  /** Wall-clock time spent inside the provider, in milliseconds. */
  latencyMs: number
  /** Provider-specific raw detail, present only when the request asked for debug output. */
  debug?: DecisionResultDebug
}

/** Build a result with the protocol fields every provider must supply. */
export function createDecisionResult(
  init: Pick<DecisionResult, 'provider' | 'mode' | 'latencyMs'> & {
    selected?: string | undefined
    ranking?: DecisionRankEntry[] | undefined
    confidence?: number | undefined
    debug?: DecisionResultDebug | undefined
  },
): DecisionResult {
  const result: DecisionResult = {
    provider: init.provider,
    mode: init.mode,
    latencyMs: init.latencyMs,
  }
  if (init.selected !== undefined) result.selected = init.selected
  if (init.ranking !== undefined) result.ranking = init.ranking
  if (init.confidence !== undefined) result.confidence = init.confidence
  if (init.debug !== undefined) result.debug = init.debug
  return result
}

/** Provider self-report consumed by the engine's preflight and by health tooling. */
export interface ProviderHealth {
  /** `ok` — usable now. `degraded` — usable but impaired. `unavailable` — cannot decide. */
  status: 'ok' | 'degraded' | 'unavailable'
  /** Human-readable explanation, required whenever status is not `ok`. */
  reason?: string
  /** Extra diagnostics (model path, load time, call counters, …). */
  details?: Record<string, unknown>
}

/**
 * Per-call context handed to a provider. Kept separate from the request so the
 * protocol stays serializable — signals and deadlines are transport, not data.
 */
export interface DecisionContext {
  /** Cancellation. Providers must observe it and settle once aborted. */
  signal?: AbortSignal
  /** Caller-side deadline in milliseconds. Providers may cap their own work to it. */
  timeoutMs?: number
  /** Whether the caller wants {@link DecisionResult.debug} populated. */
  debug?: boolean
  /** Environment id that produced the request, for provider-side instrumentation. */
  environment?: string
}

/**
 * The one interface every decision model is reached through.
 *
 * A provider reports what it can do ({@link DecisionProvider.capabilities}),
 * answers a request, and optionally reports health. It never receives a
 * browser reference, a tool name, or an action: it returns candidate ids, and
 * the environment adapter maps them.
 */
export interface DecisionProvider {
  /** Stable registry id, lowercase-kebab (`laya`, `jev`, `rules`, …). */
  readonly id: string
  /** Capabilities this provider actually implements. Requests outside them are refused. */
  readonly capabilities: readonly DecisionCapability[]
  /** Answer one decision request. Rejects with a {@link import('./errors.ts').DecisionError}. */
  decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult>
  /** Optional self-report. A provider without one is assumed healthy. */
  healthCheck?(): Promise<ProviderHealth>
  /** Release held resources (model sessions, workers). */
  dispose?(): Promise<void> | void
}
