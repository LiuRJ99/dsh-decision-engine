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
import type { DecisionEngine } from '../core/decision-engine.ts';
import { type EscalationResult } from '../core/errors.ts';
import type { DecisionTelemetrySink, DecisionTimings } from '../core/telemetry.ts';
import type { DecisionMode, DecisionResult } from '../core/types.ts';
import type { ActionResult, EnvironmentAction, EnvironmentAdapter, Objective } from '../environments/types.ts';
import type { EnvironmentRegistry } from '../environments/registry.ts';
/** How far the runtime is promoted. Nothing runs loops in `decision-only`. */
export type ExecutionMode = 'decision-only' | 'single-step' | 'bounded-loop';
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
    maxSteps: number;
    /** Hard wall-clock cap for one run, in milliseconds. Defaults to 120000. */
    maxDurationMs: number;
    /**
     * Confidence floor for acting. Applies only to `confidenceKind: 'normalized'`
     * results; a provider on its own scale is never compared with it.
     */
    confidenceThreshold: number;
    /** How many consecutive steps without a state change trigger `no_progress`. Defaults to 3. */
    noProgressLimit: number;
    /** How many times the same action may be chosen in a row before `repeated_decision`. Defaults to 3. */
    repeatedDecisionLimit: number;
    /** Per-observation budget in milliseconds. */
    observeTimeoutMs: number;
    /** Per-action budget in milliseconds. */
    executeTimeoutMs: number;
    /** Milliseconds to wait between steps, so a page or app can settle. Defaults to 0. */
    stepDelayMs: number;
    /**
     * Maximum characters of the state considered when fingerprinting for
     * progress detection. Bounds memory and keeps the fingerprint cheap.
     */
    stateFingerprintChars: number;
}
/** Partial runtime config as supplied by a caller; missing fields take defaults. */
export type RuntimeConfigInput = Partial<RuntimeConfig>;
/** Fully resolved configuration. */
export declare const DEFAULT_RUNTIME_CONFIG: RuntimeConfig;
/** What one step of the loop produced. */
export interface StepRecord {
    /** 0-based step index. */
    index: number;
    decision: DecisionResult;
    action: EnvironmentAction;
    execution?: ActionResult;
    /** Whether the action was executed (false in `decision-only` mode). */
    executed: boolean;
    timings: DecisionTimings;
}
/** Outcome of one runtime invocation. */
export interface RuntimeOutcome {
    status: 'decided' | 'executed' | 'done' | 'needs_escalation';
    environment: string;
    steps: number;
    /** Index of the step a caller confirming a single-step action should approve. */
    stepIndex?: number;
    decision?: DecisionResult;
    action?: EnvironmentAction;
    execution?: ActionResult;
    /**
     * `needs_escalation` only: the same object callers get as a tool result, so a
     * caller never has to translate.
     */
    escalation?: EscalationResult;
    /** Reason for a non-`needs_escalation` early stop (`done` via the adapter's own check). */
    stopReason?: string;
}
/** Options for one {@link DecisionRuntime.run} call. */
export interface RunOptions {
    /** Environment id, or a pre-resolved adapter. */
    environment: string | EnvironmentAdapter;
    /** What the caller wants achieved. */
    objective: Objective;
    /** How far to promote execution. Defaults to `decision-only`. */
    mode?: ExecutionMode;
    /** Override the runtime's static candidate set. */
    candidates?: Array<{
        id: string;
        description: string;
        metadata?: Record<string, unknown>;
    }>;
    /** Explicit provider for every decision in this run. */
    provider?: string;
    /** Capability to request for every decision in this run. */
    decisionMode?: DecisionMode;
    /** Per-run budget overrides. */
    config?: RuntimeConfigInput;
    /** Cancellation for the whole run. */
    signal?: AbortSignal;
    /** Whether risky actions may execute. Defaults to false — a caller must opt in. */
    allowRisky?: boolean;
    /** Keep provider debug detail on every result. */
    debug?: boolean;
}
/**
 * The runtime. One instance is shareable; per-run state lives in `run()`.
 */
export declare class DecisionRuntime {
    #private;
    constructor(engine: DecisionEngine, options?: {
        config?: RuntimeConfigInput;
        telemetry?: DecisionTelemetrySink;
        now?: () => number;
        environments?: EnvironmentRegistry;
    });
    /** The effective config for a run, given per-run overrides. */
    resolveConfig(overrides?: RuntimeConfigInput): RuntimeConfig;
    /**
     * Replace the base budgets for subsequent runs.
     *
     * Environments are not rebuilt: their adapters hold per-observation state
     * (a browser index inventory, an accessibility merge base) that a live swap
     * would silently invalidate. Environment toggles therefore take effect on the
     * next start, which is what the settings panel reports.
     */
    reconfigure(overrides: RuntimeConfigInput): void;
    /**
     * Run the loop.
     *
     * @param options - environment, objective, promotion mode, budgets.
     * @returns an outcome whose `status` is one of `decided`, `executed`, `done`, `needs_escalation`.
     *          Infrastructure failures (unknown environment, invalid request) throw a
     *          {@link DecisionError}; runtime *decisions to stop* return `needs_escalation`.
     */
    run(options: RunOptions): Promise<RuntimeOutcome>;
}
/**
 * A cheap, bounded fingerprint of an environment state, used only to detect
 * "nothing changed". It is never persisted and never sent to a model.
 *
 * @returns undefined when the state cannot be fingerprinted (null/undefined).
 */
export declare function fingerprintState(state: unknown, limit: number): string | undefined;
/** Sleep that settles early when the signal aborts. Never rejects. */
export declare function abortableSleep(ms: number, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=runner.d.ts.map