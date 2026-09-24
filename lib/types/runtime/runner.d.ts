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
    /** Repeat limit; 0 disables it. Task takeover defaults to 0, legacy loops to 3. */
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
    /**
     * What to do when a step offers exactly one candidate. `ask` (the default)
     * keeps the provider in the loop; `execute` takes the step directly, because
     * there is nothing to decide and a small local head cannot answer it at all
     * (Laya's TopK needs k=2 over one class and fails the step). Stage scopes
     * that narrow to a single control are what this policy exists for.
     */
    singleCandidateSteps: 'ask' | 'execute';
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
    /** Last observed state and environment-reported score/outcome. */
    finalState?: unknown;
    result?: Record<string, unknown>;
    /** Progress through the caller's plan; no intermediate main-agent turn. */
    completedPlanSteps?: string[];
    activePlanStep?: string;
}
/** A main-agent-planned stage. The executor chooses actions within this stage. */
export interface TaskPlanStep {
    id: string;
    objective: string;
    completion: NonNullable<Objective['completion']>;
    /** Optional action limit for this stage, within the overall task budget. */
    maxSteps?: number;
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
    scope?: Record<string, unknown>;
}
/** Options for one {@link DecisionRuntime.run} call. */
export interface RunOptions {
    /** Environment id, or a pre-resolved adapter. */
    environment: string | EnvironmentAdapter;
    /** What the caller wants achieved. */
    objective: Objective;
    /** Ordered stages supplied once by the planner; advanced from observed state. */
    plan?: TaskPlanStep[];
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
/** A whole task, executed without returning to the caller between steps. */
export type TaskOptions = Omit<RunOptions, 'mode' | 'candidates'>;
export interface TaskOutcome extends RuntimeOutcome {
    taskId: string;
    durationMs: number;
}
/** Task defaults permit repeated legal moves; finite step/time budgets remain. */
export declare const DEFAULT_TASK_CONFIG: RuntimeConfigInput;
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
     * would silently invalidate. Explicit environment configuration therefore
     * takes effect on the next start.
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
    runTask(options: TaskOptions): Promise<TaskOutcome>;
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
/** Validate budgets at the public boundary, including non-DSH callers. */
export declare function validateRuntimeConfig(config: RuntimeConfig): void;
export declare function validateCompletion(rule: Objective['completion']): void;
//# sourceMappingURL=runner.d.ts.map