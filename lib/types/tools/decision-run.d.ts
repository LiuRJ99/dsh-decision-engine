import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CompletionRule } from '../environments/types.ts';
import type { DecisionEngineService } from '../service.ts';
import type { TaskOutcome, TaskPlanStep } from '../runtime/runner.ts';
import type { ToolExecutionScope } from './execution-scope.ts';
import { type BrowserTaskOptions } from './browser-options.ts';
export interface RunTaskInput {
    browser?: BrowserTaskOptions;
    objective: string;
    /** Exactly one of environment/endpoint is required. */
    environment?: string;
    endpoint?: string;
    provider?: string;
    maxSteps?: number;
    maxDurationMs?: number;
    allowRisky?: boolean;
    completion?: CompletionRule;
    plan?: TaskPlanStep[];
}
export declare function executeRunTask(input: RunTaskInput, service: DecisionEngineService, signal?: AbortSignal): Promise<TaskOutcome>;
/** The main agent calls once; only completion or escalation returns to it. */
export declare function defineRunTool(service: DecisionEngineService, scope?: ToolExecutionScope): ToolDefinition;
//# sourceMappingURL=decision-run.d.ts.map