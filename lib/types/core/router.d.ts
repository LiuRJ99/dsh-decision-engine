/**
 * Provider routing.
 *
 * Deliberately small for the first version: an explicit provider on the
 * request wins, otherwise the configured default runs. The seam that matters
 * is that routing is a separate, replaceable policy — a later version can
 * route on candidate count, task type, latency budget, or capability without
 * touching the engine, the environments, or any provider.
 *
 * @module dsh-decision-engine/core/router
 */
import type { DecisionProviderRegistry } from './provider-registry.ts';
import type { DecisionMode, DecisionRequest } from './types.ts';
/** One routing decision, with the reason it was made. */
export interface RouteResult {
    providerId: string;
    /** Why this provider was chosen: an explicit request field, the default, or a capability fallback. */
    reason: 'explicit' | 'default' | 'capability-fallback';
}
/**
 * Routing policy for decision calls.
 */
export declare class DecisionRouter {
    #private;
    /**
     * @param registry - provider membership.
     * @param options - routing config.
     */
    constructor(registry: DecisionProviderRegistry, options?: {
        defaultProviderId?: string;
        allowCapabilityFallback?: boolean;
    });
    /** The configured default provider id, if any. */
    get defaultProviderId(): string | undefined;
    /** Whether a capability miss may fall back to another enabled provider. */
    get allowCapabilityFallback(): boolean;
    /**
     * Re-point the default provider.
     *
     * @param id - a registered, enabled provider id, or undefined to fall back to
     *   the first enabled provider.
     * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
     */
    setDefaultProvider(id: string | undefined): void;
    /** Allow or forbid capability fallback. */
    setAllowCapabilityFallback(allow: boolean): void;
    /**
     * Choose a provider for a request.
     *
     * Order: an explicit `request.provider` field; then the configured default;
     * then — only when enabled and only if the chosen provider cannot run the
     * mode — the first enabled provider that declares the capability.
     *
     * @param request - the decision request.
     * @param mode - the resolved mode.
     * @returns the chosen provider id and why.
     * @throws DecisionError with `provider_unknown`, `provider_unavailable`, or
     *   `provider_unsupported_capability`.
     */
    route(request: DecisionRequest, mode: DecisionMode): RouteResult;
}
//# sourceMappingURL=router.d.ts.map