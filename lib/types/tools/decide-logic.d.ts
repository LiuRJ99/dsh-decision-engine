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
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { DecisionConfidenceKind, DecisionMode } from '../core/types.ts';
import type { EnvironmentAction, Objective } from '../environments/types.ts';
import type { ExecutionMode, RuntimeOutcome } from '../runtime/runner.ts';
import type { DecisionEngineService } from '../service.ts';
/** Lossless-JSON object, matching what the tool output schema can carry. */
type JsonObject = Record<string, JsonValue>;
/** One candidate as the tool accepts it. */
export interface DecideCandidateInput {
    id: string;
    description: string;
    metadata?: Record<string, unknown>;
}
/** The tool's arguments. */
export interface DecideToolInput {
    /** What the caller wants achieved. */
    objective?: string;
    /** Environment state: a string, or a structured object. */
    state?: string | Record<string, unknown>;
    /** Finite candidate set. Required unless an environment derives one. */
    candidates?: DecideCandidateInput[];
    /** Required capability. Defaults to `choice`. */
    mode?: DecisionMode;
    /** Explicit provider id. Omitted routes to the default provider. */
    provider?: string;
    /** Hard constraints the decision must respect. */
    constraints?: string[];
    /** Environment id (`browser`, `computer`, or a registered custom environment). */
    environment?: string;
    /** `false`/omitted = decision only; `true` = execute one action; `"loop"` = bounded loop. */
    execute?: boolean | 'loop';
    /** Override the runtime's step budget for a loop run. */
    maxSteps?: number;
    /** Whether risky actions may execute. Defaults to false. */
    allowRisky?: boolean;
    /** Keep provider-private debug detail on the result. */
    debug?: boolean;
}
/** The tool's canonical output. */
export interface DecideToolOutput {
    status: 'decided' | 'executed' | 'done' | 'needs_escalation';
    provider?: string;
    mode?: DecisionMode;
    selected?: string;
    candidates?: string[];
    /** 0..1 confidence, comparable across providers only when `confidenceKind` is `normalized`. */
    confidence?: number;
    /** What `confidence` is: `normalized`, `provider_raw`, or `unavailable`. */
    confidenceKind?: DecisionConfidenceKind;
    /** The provider's own confidence, on the provider's own scale. Never gated on. */
    rawConfidence?: number;
    latencyMs?: number;
    /** Mapped action preview — what the decision means in the environment. */
    action?: {
        kind: string;
        candidateId: string;
        description: string;
        target?: string | number;
        risky?: boolean;
    };
    executed?: boolean;
    executionMessage?: string;
    steps?: number;
    /** Provider-private detail, present when `debug` was requested. */
    debug?: JsonObject;
    /** Guidance for the main agent when the call escalated, or a note when the mode stopped early. */
    guidance?: string;
    stopReason?: string;
}
/** Where the tool's text comes from, abstracted so tests can drive it without a host. */
export interface DecideToolContext {
    service: DecisionEngineService;
    /** The calling agent, when the host supplied one. */
    agent?: unknown;
}
/** Map the tool's `execute` argument to a runtime execution mode. */
export declare function executionModeOf(execute: DecideToolInput['execute']): ExecutionMode;
/** Build the objective the runtime and the adapters see. */
export declare function objectiveOf(input: DecideToolInput): Objective;
/**
 * Challenge a call before it runs, so a malformed request never reaches a
 * provider or an environment. Returns a reason string to deny, or undefined.
 */
export declare function preflightDecideInput(input: DecideToolInput, service: DecisionEngineService): string | undefined;
/** The tool's model-facing parameter schema. */
export declare const PARAMETERS: {
    readonly objective: {
        readonly type: "string";
        readonly description: "What the caller is trying to achieve. Prefer naming the concrete next outcome.";
    };
    readonly state: {
        readonly oneOf: readonly [{
            readonly type: "object";
            readonly additionalProperties: true;
        }, {
            readonly type: "string";
        }];
        readonly description: string;
    };
    readonly candidates: {
        readonly type: "array";
        readonly items: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly id: {
                    readonly type: "string";
                    readonly required: true;
                    readonly description: "Stable option id the decider may return.";
                };
                readonly description: {
                    readonly type: "string";
                    readonly required: true;
                    readonly description: "What choosing this option does.";
                };
                readonly metadata: {
                    readonly type: "object";
                    readonly additionalProperties: true;
                    readonly description: "Optional structured attributes of the option.";
                };
            };
        };
        readonly description: "The finite option set. Required unless environment derives one.";
    };
    readonly mode: {
        readonly type: "string";
        readonly enum: readonly ["choice", "ranking", "score", "classification"];
        readonly description: "Required capability. Defaults to choice.";
    };
    readonly provider: {
        readonly type: "string";
        readonly description: "Explicit provider id. Omit to use the configured default provider.";
    };
    readonly constraints: {
        readonly type: "array";
        readonly items: {
            readonly type: "string";
        };
        readonly description: "Hard constraints the decision must respect.";
    };
    readonly environment: {
        readonly type: "string";
        readonly description: "Environment id to observe and act in (browser, computer, or a registered custom environment).";
    };
    readonly execute: {
        readonly oneOf: readonly [{
            readonly type: "boolean";
        }, {
            readonly type: "string";
            readonly enum: readonly ["loop"];
        }];
        readonly description: "Execution level: omitted/false = preview only (default), true = execute exactly one action, \"loop\" = bounded loop.";
    };
    readonly maxSteps: {
        readonly type: "number";
        readonly description: "Step budget override for a loop run.";
    };
    readonly allowRisky: {
        readonly type: "boolean";
        readonly description: "Allow externally visible or hard-to-undo actions. Defaults to false.";
    };
    readonly debug: {
        readonly type: "boolean";
        readonly description: "Keep provider-private debug detail on the result.";
    };
};
/** Project a mapped action onto the tool's output shape. */
export declare function projectAction(action: EnvironmentAction | undefined): DecideToolOutput['action'];
/** Project a runtime outcome onto the tool's output shape. */
export declare function projectOutcome(outcome: RuntimeOutcome): DecideToolOutput;
/** Render the tool's output as the single text block the model reads. */
export declare function renderDecideOutput(output: DecideToolOutput): string;
/**
 * Execute one `decision_decide` call end to end over the composition service.
 *
 * Host-free on purpose: the tool wrapper and the integration tests call this
 * same function, so the tested path is the executed path.
 *
 * @throws DecisionError for a malformed call; a runtime *decision to stop*
 *   comes back as `status: 'needs_escalation'` instead of an error.
 */
export declare function executeDecide(input: DecideToolInput, context: DecideToolContext, signal?: AbortSignal): Promise<DecideToolOutput>;
export {};
//# sourceMappingURL=decide-logic.d.ts.map