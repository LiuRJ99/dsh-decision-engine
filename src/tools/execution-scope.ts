import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Bind nested tool calls to the caller for the lifetime of one task. */
export type ToolExecutionScope = <T>(execution: ToolRunContext, work: () => Promise<T>) => Promise<T>
