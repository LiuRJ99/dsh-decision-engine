/**
 * Embedding the decision layer in a non-DSH host.
 *
 * The pieces an external program needs are individually importable
 * (`environments/custom`, `providers/laya`, `core`, `runtime`), but wiring them
 * together by hand is four imports and three registration calls that every
 * embedder would get slightly wrong. This module is the one-call version:
 *
 * ```ts
 * import { createDecisionLayer } from 'dsh-decision-engine/embed'
 *
 * const decisions = createDecisionLayer({ modelDir: '/path/to/laya/bundle' })
 * decisions.environments.register(myGameAdapter)
 *
 * const outcome = await decisions.decide({ environment: 'my-game', objective: 'Win.' })
 * ```
 *
 * It is deliberately NOT a second implementation: it composes the same engine,
 * registry, and provider the DSH plugin uses. A host that embeds this gets the
 * identical decision contract, escalation vocabulary, and confidence rules —
 * including the `confidenceKind` requirement — without depending on the DSH
 * tool registry, which only exists inside a DSH process.
 *
 * @module dsh-decision-engine/embed
 */
import { DecisionEngine } from './core/decision-engine.ts';
import { DecisionProviderRegistry } from './core/provider-registry.ts';
import type { DecisionProvider, DecisionRequest, DecisionResult } from './core/types.ts';
import type { DecisionTelemetry, DecisionTelemetrySink } from './core/telemetry.ts';
import { EnvironmentRegistry } from './environments/registry.ts';
import type { EnvironmentAdapter, Objective } from './environments/types.ts';
import { DecisionRuntime, type ExecutionMode, type RunOptions, type RuntimeConfig, type RuntimeConfigInput, type RuntimeOutcome } from './runtime/runner.ts';
import { CustomEnvironmentAdapter, type CustomEnvironmentSpec } from './environments/custom/adapter.ts';
import type { LayaConfig } from './providers/laya/config.ts';
import type { DecisionEngineHealth } from './service.ts';
/** Options for {@link createDecisionLayer}. */
export interface EmbedOptions {
    /** Register the Laya provider. Defaults to true. */
    laya?: boolean | LayaConfig;
    /** Additional providers, tried by explicit `provider` id or as the default. */
    providers?: DecisionProvider[];
    /** Provider id used when a request does not name one. Defaults to the first registered. */
    defaultProvider?: string;
    /** Runtime budgets and stop conditions. */
    runtime?: RuntimeConfigInput;
    /** Confidence floor, applied only to `confidenceKind: 'normalized'` results. */
    confidenceThreshold?: number;
    /** Per-decision provider budget in milliseconds. */
    timeoutMs?: number;
    /** How many telemetry records to keep in memory. Defaults to 200. */
    telemetryLimit?: number;
    /** Extra telemetry consumer, in addition to the in-memory buffer. */
    telemetry?: DecisionTelemetrySink;
}
/** The decision layer an embedder drives. */
export interface EmbeddedDecisionLayer {
    /** The engine, for a caller that wants `decide()` directly. */
    readonly engine: DecisionEngine;
    /** Provider membership. */
    readonly providers: DecisionProviderRegistry;
    /** Environment membership. Register your adapters here. */
    readonly environments: EnvironmentRegistry;
    /** The bounded runtime, for single-step and loop execution. */
    readonly runtime: DecisionRuntime;
    /** The budgets in force. */
    readonly runtimeConfig: RuntimeConfig;
    /**
     * Answer one decision request.
     *
     * @throws DecisionError for every refusal, with a stable `code`. A caller that
     *   wants the escalation shape instead of an exception should use
     *   {@link EmbeddedDecisionLayer.decideEnvironment}.
     */
    decide(request: DecisionRequest): Promise<DecisionResult>;
    /**
     * Observe an environment, decide, map to a concrete action, and optionally
     * execute — returning the escalation shape rather than throwing when the layer
     * refuses to continue.
     *
     * This is the method an out-of-process bridge should call: its result is
     * directly serializable and already carries the guidance a main agent needs.
     */
    decideEnvironment(options: {
        environment: string | EnvironmentAdapter;
        objective: Objective | string;
        mode?: ExecutionMode;
        allowRisky?: boolean;
        signal?: AbortSignal;
    }): Promise<RuntimeOutcome>;
    /** Recent telemetry records, newest last. */
    telemetry(): readonly DecisionTelemetry[];
    /** Aggregate provider health. */
    health(): Promise<DecisionEngineHealth>;
    /** Release every provider (the model session included). */
    dispose(): Promise<void>;
}
/**
 * Build a decision layer for embedding.
 *
 * @param options - providers, budgets, and telemetry.
 * @returns the layer, ready for `environments.register(...)`.
 */
export declare function createDecisionLayer(options?: EmbedOptions): EmbeddedDecisionLayer;
/** Re-exported so an embedder needs one import for the common cases. */
export { CustomEnvironmentAdapter };
export type { CustomEnvironmentSpec };
export type { EnvironmentAdapter, Objective, RunOptions, RuntimeOutcome, ExecutionMode };
//# sourceMappingURL=embed.d.ts.map