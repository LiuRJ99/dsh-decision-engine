/**
 * Environment registry: `id` → {@link EnvironmentAdapter}.
 *
 * Mirrors the provider registry's shape on the other side of the layer. The
 * runtime resolves an adapter by id; nothing in the runtime imports a concrete
 * adapter, so a new environment is `register(...)` and nothing else.
 *
 * @module dsh-decision-engine/environments/registry
 */
import type { EnvironmentAdapter } from './types.ts';
/** Snapshot of one registered environment, for listing and diagnostics. */
export interface EnvironmentDescriptor {
    id: string;
    source: string;
    capabilities: readonly string[];
    /** Whether the adapter can tell when the objective is met. */
    hasIsDone: boolean;
}
/** Registry of environment adapters. */
export declare class EnvironmentRegistry {
    #private;
    /**
     * Register an adapter.
     *
     * @param adapter - the adapter. Its `id` becomes the registry key.
     * @param options - `replace: true` overrides an existing id.
     * @returns the disposer that unregisters it.
     */
    register(adapter: EnvironmentAdapter, options?: {
        replace?: boolean;
    }): () => void;
    /** Remove an adapter by id. Returns whether anything was removed. */
    unregister(id: string): boolean;
    /** Whether an id is registered. */
    has(id: string): boolean;
    /** Look up an adapter, or undefined. */
    get(id: string): EnvironmentAdapter | undefined;
    /**
     * Look up an adapter that must exist.
     *
     * @throws DecisionError with `environment_unknown`.
     */
    require(id: string): EnvironmentAdapter;
    /** Every registered environment id, in registration order. */
    ids(): string[];
    /** Descriptors for every registered adapter. */
    list(): EnvironmentDescriptor[];
    /** Dispose every registered adapter that owns resources. */
    disposeAll(): Promise<void>;
}
//# sourceMappingURL=registry.d.ts.map