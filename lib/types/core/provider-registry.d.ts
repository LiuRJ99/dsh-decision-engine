/**
 * Provider registry: the pluggable, replaceable, closable, routable set of
 * decision models the engine may reach.
 *
 * Registration is the only way a provider becomes reachable, and lookup is by
 * id. The registry never imports a concrete provider, so adding a second model
 * family is `register(...)` plus config — nothing in the engine, the
 * environments, or the runtime changes.
 *
 * @module dsh-decision-engine/core/provider-registry
 */
import { type DecisionCapability, type DecisionContext, type DecisionProvider, type DecisionMode, type DecisionRequest, type DecisionResult, type ProviderHealth } from './types.ts';
/** One registry entry: the provider plus how it is enabled. */
export interface ProviderRegistration {
    provider: DecisionProvider;
    /** Whether the provider participates in routing. A disabled provider stays registered but unroutable. */
    enabled: boolean;
    /** Free-form provider config, owned by the provider's own module. */
    config: Record<string, unknown>;
}
/** Snapshot of one registered provider, for listing and diagnostics. */
export interface ProviderDescriptor {
    id: string;
    enabled: boolean;
    capabilities: readonly DecisionCapability[];
    /** Whether the provider exposes a health check. */
    hasHealthCheck: boolean;
    /** Whether the provider is the registry's current default. */
    isDefault: boolean;
}
/** Options accepted by {@link DecisionProviderRegistry.register}. */
export interface RegisterOptions {
    /** Defaults to true. A disabled provider is registered but never routed to. */
    enabled?: boolean;
    /** Provider-owned config. Stored verbatim; the provider reads it itself. */
    config?: Record<string, unknown>;
    /**
     * Replace a provider already registered under the same id.
     * Defaults to false so an accidental double registration fails loudly.
     */
    replace?: boolean;
}
/**
 * The registry. One instance per engine; the engine owns routing policy, the
 * registry owns membership.
 */
export declare class DecisionProviderRegistry {
    #private;
    /**
     * Add a provider.
     *
     * @param provider - the provider instance. Its `id` becomes the registry key.
     * @param options - enablement and config.
     * @returns the exact disposer that unregisters this provider.
     * @throws DecisionError with `invalid_request` on a malformed id or a duplicate.
     */
    register(provider: DecisionProvider, options?: RegisterOptions): () => void;
    /** Remove a provider by id. Returns whether anything was removed. */
    unregister(id: string): boolean;
    /** Whether a provider id is registered (enabled or not). */
    has(id: string): boolean;
    /**
     * Look up a provider.
     *
     * @param id - provider id.
     * @returns the provider, or undefined.
     */
    get(id: string): DecisionProvider | undefined;
    /**
     * Look up a provider that must exist and be enabled.
     *
     * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
     */
    require(id: string): DecisionProvider;
    /** Registration entry (provider, enabled flag, config) or undefined. */
    entry(id: string): ProviderRegistration | undefined;
    /** Ids of every registered provider, enabled or not, in registration order. */
    ids(): string[];
    /** Ids of enabled providers, in registration order. */
    enabledIds(): string[];
    /**
     * Ids of enabled providers that declare `capability`.
     *
     * @param capability - the required capability.
     * @returns matching provider ids in registration order.
     */
    idsWithCapability(capability: DecisionCapability): string[];
    /** Descriptors for every registered provider. */
    list(): ProviderDescriptor[];
    /** The configured default provider id, or undefined when none is eligible. */
    getDefaultId(): string | undefined;
    /** A configured provider that has not yet been registered by its plugin. */
    getPendingDefaultId(): string | undefined;
    /** Defer routing until an independently mounted provider registers this id. */
    deferDefault(id: string): void;
    /** Use the first enabled provider without pinning a particular plugin id. */
    resetDefault(): void;
    /**
     * Set the default provider id.
     *
     * @param id - a registered, enabled provider id.
     * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
     */
    setDefault(id: string): void;
    /**
     * Resolve the provider for a request: the explicitly named one, else the
     * default.
     *
     * @param requestedId - provider the caller named, if any.
     * @returns the provider to use and its id.
     * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
     */
    resolve(requestedId?: string): {
        id: string;
        provider: DecisionProvider;
    };
    /**
     * Assert that a provider implements a mode before it is asked to run it.
     *
     * @throws DecisionError with `provider_unsupported_capability`.
     */
    assertCapability(id: string, mode: DecisionMode): void;
    /**
     * Run every enabled provider's health check.
     *
     * A provider without a health check reports `ok` with no details. A health
     * check that throws is reported as `unavailable` rather than failing the
     * whole listing — one broken provider must not blind the caller to the rest.
     */
    health(): Promise<Record<string, ProviderHealth>>;
    /** Dispose every registered provider that owns resources. */
    disposeAll(): Promise<void>;
}
/** The registry's own minimal provider-facing contract, re-exported for provider authors. */
export type { DecisionContext, DecisionProvider, DecisionRequest, DecisionResult, ProviderHealth };
//# sourceMappingURL=provider-registry.d.ts.map