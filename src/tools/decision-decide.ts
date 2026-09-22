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

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DecisionError } from '../core/errors.ts'
import type { DecideToolContext, DecideToolInput, DecideToolOutput } from './decide-logic.ts'
import {
  PARAMETERS,
  executeDecide,
  preflightDecideInput,
  renderDecideOutput,
} from './decide-logic.ts'

export type {
  DecideCandidateInput,
  DecideToolContext,
  DecideToolInput,
  DecideToolOutput,
} from './decide-logic.ts'
export {
  executeDecide,
  executionModeOf,
  objectiveOf,
  preflightDecideInput,
  projectAction,
  projectOutcome,
  renderDecideOutput,
} from './decide-logic.ts'

/** Build the tool definition. */
export function defineDecideTool(context: DecideToolContext): ToolDefinition {
  const { service } = context
  return defineTool({
    name: 'decision_decide',
    description: 'Ask the decision layer to choose among a finite candidate set, or to observe a browser/computer '
      + 'environment and choose the next action there. Returns the selected candidate, the ranked alternatives, a '
      + 'provider id, and — with an environment — the concrete action the choice maps to. Decision only by default; '
      + 'pass execute to run one action, or execute "loop" for a bounded loop. Information the environment cannot '
      + 'express as structured state comes back as status "needs_escalation", never as a guess.',
    parameters: PARAMETERS,
    timeoutMs: 180_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['decided', 'executed', 'done', 'needs_escalation'] },
          provider: { type: 'string' },
          mode: { type: 'string', enum: ['choice', 'ranking', 'score', 'classification'] },
          selected: { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          latencyMs: { type: 'number' },
          action: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true },
              candidateId: { type: 'string', required: true },
              description: { type: 'string', required: true },
              target: {
                oneOf: [
                  { type: 'string' as const },
                  { type: 'number' as const },
                ],
              },
              risky: { type: 'boolean' },
            },
          },
          executed: { type: 'boolean' },
          executionMessage: { type: 'string' },
          steps: { type: 'number' },
          debug: { type: 'object', additionalProperties: true },
          guidance: { type: 'string' },
          stopReason: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const output = value as DecideToolOutput
        return [{ type: 'text' as const, text: renderDecideOutput(output) }]
      },
    },
    execute: async (args, exec) => {
      const input = args as DecideToolInput
      const violation = preflightDecideInput(input, service)
      if (violation !== undefined) {
        throw new DecisionError('invalid_request', violation)
      }
      return executeDecide(input, { service, ...exec.agent === undefined ? {} : { agent: exec.agent } }, exec.signal)
    },
  })
}
