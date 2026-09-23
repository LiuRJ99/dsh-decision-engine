import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { DecisionError } from '../core/errors.ts'
import { HttpEnvironmentAdapter } from '../environments/http/adapter.ts'
import type { CompletionRule } from '../environments/types.ts'
import type { DecisionEngineService } from '../service.ts'
import type { TaskOutcome, TaskPlanStep } from '../runtime/runner.ts'
import type { ToolExecutionScope } from './execution-scope.ts'
import { BROWSER_OPTIONS_PARAMETER, taskEnvironment, type BrowserTaskOptions } from './browser-options.ts'

interface TaskReport {
  taskId: string
  status: string
  environment: string
  steps: number
  durationMs: number
  result?: Record<string, JsonValue>
  finalState?: string | Record<string, JsonValue>
  reason?: string
  guidance?: string
  stopReason?: string
  actionMayHaveExecuted?: boolean
  completedPlanSteps?: string[]
  activePlanStep?: string
}

export interface RunTaskInput {
  browser?: BrowserTaskOptions
  objective: string
  /** Exactly one of environment/endpoint is required. */
  environment?: string
  endpoint?: string
  provider?: string
  maxSteps?: number
  maxDurationMs?: number
  allowRisky?: boolean
  completion?: CompletionRule
  plan?: TaskPlanStep[]
}

export async function executeRunTask(input: RunTaskInput, service: DecisionEngineService, signal?: AbortSignal): Promise<TaskOutcome> {
  if (typeof input.objective !== 'string' || input.objective.trim() === '') throw new DecisionError('invalid_request', 'A task needs a non-empty objective.')
  if ((input.environment === undefined) === (input.endpoint === undefined)) throw new DecisionError('invalid_request', 'Pass exactly one of environment or endpoint.')
  if (input.maxDurationMs !== undefined && input.maxDurationMs > 1_800_000) throw new DecisionError('invalid_request', 'DSH tasks may run for at most 30 minutes per call.')
  if (input.endpoint !== undefined && input.browser !== undefined) throw new DecisionError('invalid_request', 'Browser settings cannot be used with an HTTP endpoint.')
  const environment = input.endpoint === undefined ? taskEnvironment(service, input.environment, input.browser) : new HttpEnvironmentAdapter({ endpoint: input.endpoint })
  return service.runTask({
    environment,
    objective: { description: input.objective, ...input.completion === undefined ? {} : { completion: input.completion } },
    ...input.plan === undefined ? {} : { plan: input.plan },
    ...input.provider === undefined ? {} : { provider: input.provider },
    ...signal === undefined ? {} : { signal },
    allowRisky: input.allowRisky === true,
    config: {
      ...input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps },
      ...input.maxDurationMs === undefined ? {} : { maxDurationMs: input.maxDurationMs },
    },
  })
}

/** The main agent calls once; only completion or escalation returns to it. */
export function defineRunTool(service: DecisionEngineService, scope?: ToolExecutionScope): ToolDefinition {
  return defineTool({
    name: 'decision_run',
    description: 'Hand over an entire game, website, or desktop task to the decision executor. '
      + 'It independently observes, decides and executes until completion or escalation, then returns the final result and score. '
      + 'Use endpoint for a dsh-environment/v1 HTTP API, or environment for a registered adapter. '
      + 'Do not fetch state, forward questions, click next, or call this once per move: the executor owns all intermediate steps. '
      + 'Pass the main agent\'s ordered plan once; the small model selects actions within each stage, and observed completion advances it. '
      + 'Browser/desktop tasks need a plan with completion rules, a completion rule, or an adapter that reports completion.',
    timeoutMs: 1_860_000,
    parameters: {
      objective: { type: 'string', required: true, description: 'The whole task and intended final outcome.' },
      environment: { type: 'string', description: 'Registered environment id, such as browser or computer.' },
      browser: BROWSER_OPTIONS_PARAMETER,
      endpoint: { type: 'string', description: 'Base URL of the environment API exposing GET state and POST action.' },
      provider: { type: 'string', description: 'Optional decision provider id.' },
      maxSteps: { type: 'integer', description: 'Total action budget; defaults to 1000.' },
      maxDurationMs: { type: 'number', description: 'Total task deadline in milliseconds; defaults to 600000, maximum 1800000.' },
      allowRisky: { type: 'boolean', description: 'Allow actions marked risky within the authorized task.' },
      plan: {
        type: 'array', description: 'Ordered execution plan from the main agent. No main-agent intervention between stages.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            objective: { type: 'string', required: true, description: 'Actions and scope for this stage.' },
            maxSteps: { type: 'integer' },
            scope: {
              type: 'object', additionalProperties: true,
              description: 'What the driver may do while this stage is active, interpreted by the environment adapter. '
                + 'For the browser environment: candidateSelector, includeNonSemantic, maxCandidates. Narrowing a stage '
                + 'removes the wrong choices instead of asking the model to ignore them.',
            },
            completion: {
              type: 'object', required: true, additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                equals: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
                includes: { type: 'string' },
              },
            },
          },
        },
      },
      completion: {
        type: 'object', additionalProperties: false,
        description: 'Optional structured completion condition. For browser text, path is main. Supply exactly one of equals/includes.',
        properties: {
          path: { type: 'string', required: true },
          equals: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
          includes: { type: 'string' },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          environment: { type: 'string', required: true },
          steps: { type: 'integer', required: true },
          durationMs: { type: 'number', required: true },
          result: { type: 'object', additionalProperties: true },
          finalState: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] },
          reason: { type: 'string' },
          guidance: { type: 'string' },
          stopReason: { type: 'string' },
          actionMayHaveExecuted: { type: 'boolean' },
          completedPlanSteps: { type: 'array', items: { type: 'string' } },
          activePlanStep: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: async (args, execution) => {
      const work = async () => {
        const outcome = await executeRunTask(args as RunTaskInput, service, execution.signal)
        const value = {
          taskId: outcome.taskId, status: outcome.status, environment: outcome.environment,
          steps: outcome.steps, durationMs: outcome.durationMs,
          ...outcome.result === undefined ? {} : { result: outcome.result },
          ...typeof outcome.finalState === 'string' || (typeof outcome.finalState === 'object' && outcome.finalState !== null && !Array.isArray(outcome.finalState))
            ? { finalState: outcome.finalState } : {},
          ...outcome.escalation === undefined ? {} : { reason: outcome.escalation.reason, guidance: outcome.escalation.guidance },
          ...outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason },
          ...outcome.escalation?.details?.actionMayHaveExecuted === true ? { actionMayHaveExecuted: true } : {},
          ...outcome.completedPlanSteps === undefined ? {} : { completedPlanSteps: outcome.completedPlanSteps },
          ...outcome.activePlanStep === undefined ? {} : { activePlanStep: outcome.activePlanStep },
        }
        return JSON.parse(JSON.stringify(value)) as TaskReport
      }
      return scope === undefined ? work() : scope(execution, work)
    },
  })
}
