/**
 * Tool dispatch seam used by the environment adapters.
 *
 * The decision layer must not import a Browser or Computer internal file, and
 * it must not bypass the session's capability gate. Both constraints are
 * satisfied the same way: an adapter observes and acts by dispatching the
 * host's own registered tools through the public tool registry, exactly as a
 * model would. Authorization, approval, timeouts, and presentation therefore
 * stay entirely inside the existing capability system — this layer inherits
 * them and cannot widen them.
 *
 * @module dsh-decision-engine/environments/dispatch
 */

import { DecisionError } from '../core/errors.ts'

/** Result of one dispatched tool call. */
export interface ToolCallResult {
  /** Whether the tool reported success. */
  ok: boolean
  /** Concatenated text content of the result. */
  text: string
  /** Error message when `ok` is false. */
  error?: string
}

/** One tool call request. */
export interface ToolCallRequest {
  /** Registered tool name, verbatim (`browser_snapshot`, `computer_use_click`, …). */
  name: string
  /** Tool arguments, verbatim. */
  arguments: Record<string, unknown>
  /** Cancellation. */
  signal?: AbortSignal
}

/**
 * The one thing environment adapters need from the host: call a registered
 * tool by name. Implemented over `ctx.tools.execute` in the plugin entry, and
 * over a plain function in tests.
 */
export interface ToolDispatcher {
  /**
   * Dispatch one tool call.
   *
   * Implementations must NOT throw for a tool-level failure (denied by the
   * capability gate, unknown tool, tool error): return `ok: false` with the
   * tool's own message so the adapter can turn it into an observation status
   * or an escalation. Throw only for an infrastructure failure.
   */
  call(request: ToolCallRequest): Promise<ToolCallResult>
  /** Names of currently visible tools, when the transport can report them cheaply. */
  availableTools?(): readonly string[]
}

/** Build a failing result with a message. */
export function toolFailure(name: string, message: string): ToolCallResult {
  return { ok: false, text: '', error: `${name}: ${message}` }
}

/** Build a succeeding result. */
export function toolSuccess(name: string, text: string): ToolCallResult {
  void name
  return { ok: true, text }
}

/**
 * A dispatcher over a fixed `name → handler` map. Used by tests and by the
 * custom-environment path, where no host tool is involved.
 */
export function createMapDispatcher(handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolCallResult> | ToolCallResult>): ToolDispatcher {
  return {
    availableTools: () => Object.keys(handlers),
    async call(request) {
      const handler = handlers[request.name]
      if (handler === undefined) {
        return toolFailure(request.name, `no handler is registered for this tool (available: ${Object.keys(handlers).join(', ') || 'none'})`)
      }
      try {
        return await handler(request.arguments)
      } catch (error) {
        return toolFailure(request.name, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** Options every dispatch call carries. */
export interface DispatchOptions {
  signal?: AbortSignal
}

/** Assert that a dispatcher is usable, with a typed error rather than a bare one. */
export function requireDispatcher(dispatcher: ToolDispatcher | undefined, environmentId: string): ToolDispatcher {
  if (dispatcher === undefined) {
    throw new DecisionError('environment_unavailable', `Environment "${environmentId}" has no tool dispatcher wired in this deployment.`, {
      subject: environmentId,
      details: { hint: 'The decision-engine plugin wires it automatically; a hand-built adapter needs one passed in.' },
    })
  }
  return dispatcher
}
