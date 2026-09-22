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
export type DecisionCapability = 'choice' | 'ranking' | 'score' | 'classification';
/** Every capability, in canonical order. Useful for config validation and prompts. */
export declare const DECISION_CAPABILITIES: readonly DecisionCapability[];
/** Request mode. Structurally identical to a capability; the mode IS the required capability. */
export type DecisionMode = DecisionCapability;
/** Whether `value` names a known decision capability. */
export declare function isDecisionCapability(value: unknown): value is DecisionCapability;
/**
 * One option the decider may pick. The candidate set is supplied by the
 * caller and is finite by contract: a decision provider selects, ranks, or
 * scores these ids and may never invent an id that is not present here.
 */
export interface DecisionCandidate {
    /** Stable id. It must mean the same thing across repeated decisions in one workflow. */
    id: string;
    /** Human/model-readable description of what choosing this id does. */
    description: string;
    /** Optional structured attributes of the option (cost, risk, target ref, …). */
    metadata?: Record<string, unknown>;
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
    objective?: string;
    /** Environment state, verbatim. Never interpreted by the engine. */
    state: string | Record<string, unknown>;
    /** The finite option set. */
    candidates: DecisionCandidate[];
    /** Explicit constraints the decider must respect. */
    constraints?: string[];
    /** Required capability; defaults to `choice`. */
    mode?: DecisionMode;
    /**
     * Explicit provider id. Omitted means "route by policy" — the engine's
     * configured default. This is the one routing field that belongs on the
     * protocol rather than in `metadata`, because it is part of what the caller
     * is asking for, not a hint about the environment.
     */
    provider?: string;
    /** Free-form routing hints and adapter-supplied context (environment id, step index, …). */
    metadata?: Record<string, unknown>;
}
/** One ranked entry of a {@link DecisionResult}. */
export interface DecisionRankEntry {
    /** A candidate id from the request. */
    id: string;
    /** Provider score for this candidate. Meaningful relative to the same result's other scores. */
    score?: number;
}
/**
 * Provider-private raw payload. Kept in a dedicated slot so no consumer can
 * mistake it for protocol, and only attached when the caller asked for debug
 * detail.
 */
export interface DecisionResultDebug {
    /** Provider-specific raw response, verbatim (probabilities, per-question answers, …). */
    raw?: unknown;
    /**
     * The provider's own confidence value, before normalization.
     *
     * This exists because confidence numbers are **not comparable across
     * providers**: a language-model choice head reports a distribution
     * statistic, a classifier reports a posterior, a rule engine may report a
     * margin, and an RL policy may report a value estimate. Keeping the raw
     * number here — rather than in {@link DecisionResult.confidence} — is what
     * stops one provider's scale from being read as another's.
     */
    rawConfidence?: number;
    /** Provider-specific notes (which rule fired, which fallback ran, …). */
    notes?: string[];
}
/**
 * What kind of number {@link DecisionResult.confidence} is.
 *
 * - `normalized` — the provider mapped its own confidence onto a 0..1 scale
 *   that is comparable across decisions, so the engine's global
 *   `confidenceThreshold` applies.
 * - `provider_raw` — the number is the provider's own, on its own scale. The
 *   engine passes it through and **does not** gate on it, because comparing it
 *   with a threshold calibrated for a different provider would be meaningless.
 * - `unavailable` — this provider/mode cannot produce a comparable confidence.
 *   Nothing gates on it, and a decision is still valid.
 */
export type DecisionConfidenceKind = 'normalized' | 'provider_raw' | 'unavailable';
/** Every confidence kind, for validation and diagnostics. */
export declare const DECISION_CONFIDENCE_KINDS: readonly DecisionConfidenceKind[];
/** Whether `value` names a known confidence kind. */
export declare function isDecisionConfidenceKind(value: unknown): value is DecisionConfidenceKind;
/**
 * The normalized answer. Every provider returns this shape regardless of the
 * model behind it.
 */
export interface DecisionResult {
    /**
     * Id of the provider that answered.
     *
     * A provider may override this from its own return value to name the **arm**
     * that actually answered — a composite provider (say one that tries a model
     * and falls back to local rules) can report `laya` vs `rules` instead of the
     * single id it is registered under. Omitted, the engine stamps the registered
     * provider id. The id is descriptive only: routing already happened.
     */
    provider: string;
    /** Capability that was actually exercised (equals the request mode). */
    mode: DecisionMode;
    /** Chosen candidate id — the only field an Action Mapper needs for a single step. */
    selected?: string;
    /** Full ordered preference, best first. Always includes every candidate the provider scored. */
    ranking?: DecisionRankEntry[];
    /**
     * Confidence on a 0..1 scale, **together with** {@link confidenceKind}
     * saying what that scale is.
     *
     * A consumer must never read this field without reading the kind: the same
     * number means different things depending on which provider produced it and
     * whether that provider normalized it.
     */
    confidence?: number;
    /**
     * What {@link confidence} is. Required whenever `confidence` is present —
     * an unlabelled number is exactly the cross-provider ambiguity this field
     * exists to remove.
     */
    confidenceKind?: DecisionConfidenceKind;
    /** Wall-clock time spent inside the provider, in milliseconds. */
    latencyMs: number;
    /**
     * Resource usage, when the provider can report it.
     *
     * Part of the protocol rather than provider-private detail because every
     * integrator ends up accounting for the model it calls; without this field
     * they reach into a provider's internal statistics, which is exactly the
     * coupling the provider boundary exists to prevent.
     */
    usage?: DecisionUsage;
    /** Provider-specific raw detail, present only when the request asked for debug output. */
    debug?: DecisionResultDebug;
}
/** What one decision cost, in the units the provider can measure. */
export interface DecisionUsage {
    /** Input tokens billed or consumed, when the provider is a language model. */
    inputTokens?: number;
    /** Output tokens, when the provider distinguishes them. */
    outputTokens?: number;
    /** Provider-specific counters, for a provider whose cost model has no tokens. */
    metrics?: Record<string, number>;
}
/** Build a result with the protocol fields every provider must supply. */
export declare function createDecisionResult(init: Pick<DecisionResult, 'provider' | 'mode' | 'latencyMs'> & {
    selected?: string | undefined;
    ranking?: DecisionRankEntry[] | undefined;
    confidence?: number | undefined;
    confidenceKind?: DecisionConfidenceKind | undefined;
    usage?: DecisionUsage | undefined;
    debug?: DecisionResultDebug | undefined;
}): DecisionResult;
/**
 * One entry of a probability distribution, for a provider that has to derive a
 * comparable confidence from its own numbers.
 */
export interface ProbabilityEntry {
    id: string;
    probability: number;
}
/**
 * Derive a comparable 0..1 confidence from a probability distribution: how far
 * the winning option stands above the runner-up, relative to everything
 * considered.
 *
 * This is the normalization a provider with a *distribution* should use,
 * because it measures the thing the engine's threshold is actually about —
 * "is this decision dominant?" — instead of a dispersion statistic like
 * entropy, whose value depends mostly on how many options were on the ballot.
 * A 3-way choice split 0.46/0.41/0.14 and a 3-way choice split 0.97/0.02/0.01
 * have very different entropy confidences but the same option count; only the
 * margin separates them.
 *
 * @param entries - the distribution, in any order. Non-finite values are ignored.
 * @returns `decided − runnerUp` normalized by the total, or `undefined` when
 *   fewer than two usable entries exist (a single option is not a choice).
 */
export declare function normalizeConfidenceFromDistribution(entries: readonly ProbabilityEntry[]): number | undefined;
/** Clamp to the closed unit interval; a non-finite input becomes 0. */
export declare function clampUnit(value: number): number;
/** Provider self-report consumed by the engine's preflight and by health tooling. */
export interface ProviderHealth {
    /** `ok` — usable now. `degraded` — usable but impaired. `unavailable` — cannot decide. */
    status: 'ok' | 'degraded' | 'unavailable';
    /** Human-readable explanation, required whenever status is not `ok`. */
    reason?: string;
    /** Extra diagnostics (model path, load time, call counters, …). */
    details?: Record<string, unknown>;
}
/**
 * Per-call context handed to a provider. Kept separate from the request so the
 * protocol stays serializable — signals and deadlines are transport, not data.
 */
export interface DecisionContext {
    /** Cancellation. Providers must observe it and settle once aborted. */
    signal?: AbortSignal;
    /** Caller-side deadline in milliseconds. Providers may cap their own work to it. */
    timeoutMs?: number;
    /** Whether the caller wants {@link DecisionResult.debug} populated. */
    debug?: boolean;
    /** Environment id that produced the request, for provider-side instrumentation. */
    environment?: string;
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
    readonly id: string;
    /** Capabilities this provider actually implements. Requests outside them are refused. */
    readonly capabilities: readonly DecisionCapability[];
    /** Answer one decision request. Rejects with a {@link import('./errors.ts').DecisionError}. */
    decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult>;
    /** Optional self-report. A provider without one is assumed healthy. */
    healthCheck?(): Promise<ProviderHealth>;
    /** Release held resources (model sessions, workers). */
    dispose?(): Promise<void> | void;
}
//# sourceMappingURL=types.d.ts.map