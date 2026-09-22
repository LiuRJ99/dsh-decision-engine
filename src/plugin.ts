/**
 * The Cordis plugin entry: the only file that knows the host.
 *
 * It builds a composition (from `composition.ts`) over the host's public tool
 * registry and publishes it as `ctx.decisionEngine`. Everything that can be
 * tested without a DSH process lives in `composition.ts`; this file is kept
 * deliberately thin so the host-facing surface stays small and reviewable.
 *
 * @module dsh-decision-engine/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { toDecisionFailure } from './core/errors.ts'
import { toolFailure, type ToolCallRequest, type ToolCallResult, type ToolDispatcher } from './environments/dispatch.ts'
import { createDecisionEngineComposition, type Config } from './composition.ts'
import type { ComputerSeam } from './environments/computer/adapter.ts'
import { defineDecideTool } from './tools/decision-decide.ts'
import { queryCapabilityUnlocked, TOOL_LAZY_GATE_SERVICE } from './gate.ts'
import { DECISION_CONTROL_SKILL } from './skill.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'decision-engine'

/** Host services this plugin requires. Everything else is consumed opportunistically. */
export const inject = ['tools']

/**
 * A {@link ToolDispatcher} over the host tool registry.
 *
 * This is the seam that keeps the decision layer honest. Dispatching through
 * `ctx.tools.execute` means an environment call travels the same pipeline as a
 * model call: pre-execute policy, the session capability gate's monotonic
 * guard, approval, timeout wrappers, post-execute. A capability the user has
 * not unlocked therefore refuses a decision-engine call for exactly the same
 * reason it refuses a model call — and this plugin has no code path that could
 * do otherwise.
 */
export class HostToolDispatcher implements ToolDispatcher {
  readonly #ctx: Context
  #callCounter = 0

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  availableTools(): readonly string[] {
    try {
      return this.#ctx.tools.schemas().map(schema => schema.name)
    } catch {
      return []
    }
  }

  async call(request: ToolCallRequest): Promise<ToolCallResult> {
    const tools = this.#ctx.get('tools')
    if (tools === undefined) {
      return toolFailure(request.name, 'the host tool registry is not mounted')
    }
    const agent = requestAgent(this.#ctx)
    this.#callCounter += 1
    const callId = `decision-engine:${this.#callCounter}`
    try {
      const result = await tools.execute({
        callId: callId as never,
        name: request.name,
        arguments: request.arguments,
        ...agent === undefined ? {} : { agent },
        signal: request.signal ?? new AbortController().signal,
      })
      const text = result.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .filter(part => part !== '')
        .join('\n')
      if (result.isError) {
        const message = typeof result.error === 'object' && result.error !== null && 'message' in result.error
          ? String((result.error as { message: unknown }).message)
          : text
        return { ok: false, text, error: `${request.name}: ${message === '' ? 'the tool call failed' : message}` }
      }
      return { ok: true, text }
    } catch (error) {
      const failure = toDecisionFailure(error)
      return toolFailure(request.name, failure.message)
    }
  }
}

/** The agent to attribute a nested dispatch to, when the host exposes one on the context. */
function requestAgent(ctx: Context): Agent | undefined {
  const candidate = (ctx as unknown as { agent?: unknown }).agent
  return candidate === undefined || candidate === null ? undefined : candidate as Agent
}

/**
 * Cordis plugin entry.
 *
 * @param ctx - host context with the tool registry.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return

  const dispatcher = new HostToolDispatcher(ctx)
  const gate = (): unknown => ctx.get(TOOL_LAZY_GATE_SERVICE as never)
  const computerSeam = ctx.get('computer' as never) as ComputerSeam | undefined

  const composition = createDecisionEngineComposition({
    config,
    dispatcher,
    ...computerSeam === undefined ? {} : { computerSeam },
    readCapabilityGate: (capability: 'browser' | 'computer') => {
      const agent = requestAgent(ctx)
      return queryCapabilityUnlocked(gate(), agent, capability)
    },
  })

  // Publish the service on this context. `ctx.provide` owns the disposer, so
  // unloading the plugin (or the preset scope that mounted it) removes the
  // service and disposes the composition in one step.
  ctx.provide('decisionEngine' as never, composition.service as never)
  ctx.effect(() => () => {
    void composition.dispose()
  }, 'decision-engine composition')

  // One tool. Registration is scoped to the calling context, so a preset that
  // mounts this plugin in one agent scope exposes the tool there only.
  ctx.tools.register(defineDecideTool({ service: composition.service }))

  const skills = ctx.get('skills')
  if (skills !== undefined) {
    ctx.effect(() => (skills as { register(skill: unknown): () => void }).register(DECISION_CONTROL_SKILL), 'decision-control skill')
  }

  ctx.systemPrompt.section({
    name: 'tool:decision',
    order: 106,
    text: 'The decision layer answers with a finite candidate set, never free-form actions: call '
      + '`decision_decide` with an objective, the environment state (or an environment id), and the candidates. It '
      + 'decides by default; pass execute: true to run one mapped action, or execute: "loop" for a bounded loop. When '
      + 'the environment cannot express the task as structured state it returns status "needs_escalation" — take the '
      + 'step over yourself instead of retrying.',
  })
}

/** Re-export the public surface so a plugin consumer imports one module. */
export { createDecisionEngineComposition } from './composition.ts'
export type { Config } from './composition.ts'
export * from './core/types.ts'
export * from './core/errors.ts'
export * from './core/telemetry.ts'
export * from './environments/types.ts'
export * from './runtime/runner.ts'
export * from './service.ts'
export { LayaDecisionProvider } from './providers/laya/provider.ts'
export { LayaRuntime } from './providers/laya/runtime.ts'
export type { LayaConfig } from './providers/laya/config.ts'
export { executeDecide, renderDecideOutput } from './tools/decide-logic.ts'
export { DECISION_CONTROL_SKILL, DECISION_CONTROL_SKILL_NAME } from './skill.ts'
export { GATE_SKILL_NAMES, queryCapabilityUnlocked, TOOL_LAZY_GATE_SERVICE } from './gate.ts'
