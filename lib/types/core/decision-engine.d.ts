/**
 * The Decision Engine: one entry point, `decide(request)`.
 *
 * The engine owns exactly four things and nothing else:
 *
 * 1. request validation (the finite-candidate contract),
 * 2. provider selection through the router,
 * 3. capability assertion and deadline enforcement around the provider call,
 * 4. result normalization and confidence gating.
 *
 * It has no knowledge of any environment, tool, or model. Environments are
 * driven by the runtime on top of the engine; providers plug in through the
 * registry.
 *
 * @module dsh-decision-engine/core/decision-engine
 */
import { DecisionProviderRegistry } from './provider-registry.ts';
import { DecisionRouter } from './router.ts';
import type { DecisionTelemetrySink } from './telemetry.ts';
import type { DecisionRequest, DecisionResult, ProviderHealth } from './types.ts';
/** Engine configuration. */
export interface DecisionEngineConfig {
    /** Provider id used when a request does not name one. */
    defaultProviderId?: string;
    /**
     * Confidence floor for a `choice`/`classification` decision, applied **only
     * to `confidenceKind: 'normalized'` results**.
     *
     * A provider whose confidence is on its own scale (`provider_raw`) or absent
     * (`unavailable`) is not gated: this threshold is calibrated for one
     * comparable scale, and applying it to a different provider's number would
     * refuse that provider's perfectly good decisions. Set to 0 to accept
     * anything normalized.
     */
    confidenceThreshold?: number;
    /** Per-call provider budget in milliseconds. Defaults to 30000. */
    timeoutMs?: number;
    /** Whether the router may fall back to another provider on a capability miss. Defaults to true. */
    allowCapabilityFallback?: boolean;
    /** Telemetry consumer. Failures inside it never affect a decision. */
    telemetry?: DecisionTelemetrySink;
    /**
     * Injectable clock, for tests. Returns milliseconds, and should be
     * sub-millisecond precise: the layer's own overhead is well under 1 ms, so an
     * integer-millisecond clock cannot measure it. Defaults to `performance.now()`.
     */
    now?: () => number;
}
/**
 * Default confidence floor for the one scale it applies to.
 *
 * This is a *normalized* threshold: it is compared only with
 * `confidenceKind: 'normalized'` results, so a provider that reports its own
 * scale (`provider_raw`) or none (`unavailable`) is unaffected. Deployments
 * whose providers produce comparable confidence tune it; deployments whose
 * providers do not can leave it alone, because it never fires for them.
 */
export declare const DEFAULT_CONFIDENCE_THRESHOLD = 0.55;
/** Options for one {@link DecisionEngine.decide} call. */
export interface EngineDecideOptions {
    /** Explicit provider for this call; overrides the request's own `provider` field. */
    provider?: string;
    /** Cancellation forwarded to the provider. */
    signal?: AbortSignal;
    /** Per-call budget override, in milliseconds. */
    timeoutMs?: number;
    /** Ask the provider for private debug detail and keep it on the result. */
    debug?: boolean;
    /** Environment id recorded in telemetry and forwarded to the provider. */
    environment?: string;
    /**
     * Runtime step index, when this decision is one step of a run. Present means
     * the runtime is driving, and the emitted record carries the step's
     * per-layer timings — one record per step, not two.
     */
    step?: number;
    /**
     * Per-layer timings the caller already measured (observation, mapping,
     * execution). Merged into the emitted record so a slow environment is never
     * reported as a slow model.
     */
    sourceTimings?: {
        observeMs?: number;
        mapMs?: number;
        executeMs?: number;
    };
    /**
     * Override the confidence floor for this call. `0` accepts any confidence;
     * `undefined` uses the engine's configured floor.
     */
    confidenceThreshold?: number;
}
/**
 * The engine.
 *
 * Instances are safe to share: `decide` holds no cross-call state.
 */
export declare class DecisionEngine {
    #private;
    constructor(config?: DecisionEngineConfig, registry?: DecisionProviderRegistry);
    /** The provider registry, so a composition root can register providers. */
    get registry(): DecisionProviderRegistry;
    /** The routing policy, exposed read-only for diagnostics. */
    get router(): DecisionRouter;
    /** The configured confidence floor. */
    get confidenceThreshold(): number;
    /** Per-decision ceiling, also honored inside a longer task. */
    get timeoutMs(): number;
    /**
     * Apply a configuration change to the live engine.
     *
     * The engine holds no per-call state, so this is safe to call at any time —
     * a decision already in flight keeps the values it started with. The default
     * provider is re-pointed through the registry, which validates it.
     */
    reconfigure(config: DecisionEngineConfig): void;
    /**
     * Answer one decision request.
     *
     * @param request - objective, state, finite candidates, optional mode/provider.
     * @param options - transport concerns: cancellation, budget, debug, environment.
     * @returns the normalized decision result.
     * @throws DecisionError for every refusal; never a bare Error.
     */
    decide(request: DecisionRequest, options?: EngineDecideOptions): Promise<DecisionResult>;
    /** Health of every registered provider. */
    health(): Promise<Record<string, ProviderHealth>>;
    /** Dispose every provider and clear the registry. */
    dispose(): Promise<void>;
}
//# sourceMappingURL=decision-engine.d.ts.map