/**
 * `decision_decide` — the decision tool: its model-facing schema and its
 * execution over the composition root's service.
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
 * The pure half of this surface — arguments, preflight, projection, rendering —
 * lives in `decide-logic.ts`, so it stays testable without a host process.
 *
 * @module dsh-decision-engine/tools/decision-decide
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { DecideToolContext } from './decide-logic.ts';
export type { DecideCandidateInput, DecideToolContext, DecideToolInput, DecideToolOutput, } from './decide-logic.ts';
export { executeDecide, executionModeOf, objectiveOf, preflightDecideInput, projectAction, projectOutcome, renderDecideOutput, } from './decide-logic.ts';
/** Build the tool definition. */
export declare function defineDecideTool(context: DecideToolContext): ToolDefinition;
//# sourceMappingURL=decision-decide.d.ts.map