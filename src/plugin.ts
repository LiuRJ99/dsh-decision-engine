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
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { toDecisionFailure } from './core/errors.ts'
import { toolFailure, type ToolCallRequest, type ToolCallResult, type ToolDispatcher } from './environments/dispatch.ts'
import { Config as ConfigSchema, createDecisionEngineComposition, type Config, type DecisionEngineComposition } from './composition.ts'
import { defineDecideTool } from './tools/decision-decide.ts'
import { defineRunTool } from './tools/decision-run.ts'
import type { ToolExecutionScope } from './tools/execution-scope.ts'
import { queryCapabilityUnlocked, TOOL_LAZY_GATE_SERVICE } from './gate.ts'
import { DECISION_CONTROL_SKILL } from './skill.ts'
import { DEFAULT_RUNTIME_CONFIG, validateRuntimeConfig } from './runtime/runner.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'decision-engine'

/** Host services this plugin requires. Everything else is consumed opportunistically. */
export const inject = ['tools', 'systemPrompt', 'settings']

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
  readonly #execution: () => ToolRunContext | undefined
  #callCounter = 0

  constructor(ctx: Context, execution: () => ToolRunContext | undefined = () => undefined) {
    this.#ctx = ctx
    this.#execution = execution
  }

  availableTools(): readonly string[] {
    try {
      return this.#ctx.tools.schemas(this.#execution()?.agent).map(schema => schema.name)
    } catch {
      return []
    }
  }

  async call(request: ToolCallRequest): Promise<ToolCallResult> {
    const tools = this.#ctx.get('tools')
    if (tools === undefined) {
      return toolFailure(request.name, 'the host tool registry is not mounted')
    }
    const execution = this.#execution()
    const agent = execution?.agent ?? requestAgent(this.#ctx)
    this.#callCounter += 1
    const callId = `decision-engine:${this.#callCounter}`
    try {
      const result = await tools.execute({
        callId: callId as never,
        name: request.name,
        arguments: request.arguments,
        ...agent === undefined ? {} : { agent },
        ...execution === undefined ? {} : { parent: execution.token, rootCallId: execution.rootCallId },
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
  const candidate = ctx.get('agent')
  return candidate === undefined || candidate === null ? undefined : candidate as Agent
}

/**
 * Cordis plugin entry.
 *
 * @param ctx - host context with the tool registry.
 * @param config - validated plugin config.
 */
/**
 * Settings namespace the plugin owns.
 *
 * The host settings namespace supplies the resolved data and write endpoint;
 * the Web client entry registers a first-level section in the settings panel.
 */
export const SETTINGS_NAMESPACE = 'decision-engine' as const

/** The settings surface this plugin consumes, structurally typed. */
interface SettingsSurface {
  register(
    ns: string,
    schema: unknown,
    options: { base?: unknown; applies?: 'live' | 'restart'; validate?: (value: Config) => void },
  ): {
    get(): unknown
    watch(listener: () => void): () => void
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return

  const execution = new AsyncLocalStorage<ToolRunContext>()
  const scope: ToolExecutionScope = (caller, work) => execution.run(caller, work)
  const dispatcher = new HostToolDispatcher(ctx, () => execution.getStore())
  const gate = (): unknown => ctx.get(TOOL_LAZY_GATE_SERVICE as never)

  // The persisted section must be read before construction: provider and
  // environment changes marked "restart" need to shape the next instance.
  let activeComposition: DecisionEngineComposition | undefined
  const settings = ctx.get('settings') as unknown as SettingsSurface | undefined
  const settingsScope = settings?.register(SETTINGS_NAMESPACE, ConfigSchema, {
    base: config,
    applies: 'live',
    validate: (value: Config) => {
      if (activeComposition !== undefined && value.defaultProvider !== undefined
        && !activeComposition.providers.has(value.defaultProvider)
        && !(value.defaultProvider === 'laya' && value.providers?.laya?.enabled === false)) {
        throw new Error(`defaultProvider "${value.defaultProvider}" is not registered`)
      }
      validateRuntimeConfig({ ...DEFAULT_RUNTIME_CONFIG, ...value.runtime })
    },
  })
  const initialConfig = settingsScope?.get() as Config | undefined ?? config
  if (initialConfig.enabled === false) return

  const composition = createDecisionEngineComposition({
    config: initialConfig,
    dispatcher,
    readCapabilityGate: (capability: 'browser' | 'computer') => {
      const agent = execution.getStore()?.agent ?? requestAgent(ctx)
      return queryCapabilityUnlocked(gate(), agent, capability)
    },
  })
  activeComposition = composition

  // Publish the service on this context. `ctx.provide` owns the disposer, so
  // unloading the plugin (or the preset scope that mounted it) removes the
  // service and disposes the composition in one step.
  ctx.provide('decisionEngine' as never, composition.service as never)
  ctx.effect(() => () => {
    void composition.dispose()
  }, 'decision-engine composition')

  // Both tools are scoped to the calling context, so a preset that mounts
  // this plugin in one agent scope exposes them there only.
  ctx.tools.register(defineDecideTool({ service: composition.service }, scope))
  ctx.tools.register(defineRunTool(composition.service, scope))

  const skills = ctx.get('skills')
  if (skills !== undefined) {
    ctx.effect(() => (skills as { register(skill: unknown): () => void }).register(DECISION_CONTROL_SKILL), 'decision-control skill')
  }

  // Subsequent writes update live routing and budgets. Provider instances and
  // environment adapters are rebuilt from settings on the next host start.
  if (settingsScope !== undefined) {
    const applySettings = (): void => {
      let resolved: Config
      try {
        resolved = settingsScope.get() as Config
      } catch {
        return
      }
      if (resolved === undefined || resolved === null) return
      try {
        // Assign the fields explicitly rather than spreading a conditional
        // object: a spread defeats excess-property checking, which is exactly
        // how `observeTimeoutMs` (not an engine field) was silently dropped
        // while the settings panel cheerfully stored it.
        const engineConfig: Parameters<typeof composition.service.engine.reconfigure>[0] = {}
        if (resolved.runtime?.confidenceThreshold !== undefined) engineConfig.confidenceThreshold = resolved.runtime.confidenceThreshold
        if (resolved.runtime?.observeTimeoutMs !== undefined) engineConfig.timeoutMs = resolved.runtime.observeTimeoutMs
        composition.setDefaultProvider(resolved.defaultProvider)
        composition.service.engine.reconfigure(engineConfig)
        if (resolved.runtime !== undefined) composition.service.runtime.reconfigure(resolved.runtime)
      } catch (error) {
        // A half-edited settings document must not break decisions: the engine
        // keeps its last good configuration. The refusal is logged rather than
        // swallowed, because a silently ignored write is a configuration page
        // that lies about what it applied.
        ctx.logger?.warn?.('decision-engine: settings change was not applied: %s', error instanceof Error ? error.message : String(error))
      }
    }
    ctx.effect(() => settingsScope.watch(() => applySettings()), 'decision-engine settings watch')
  }

  ctx.systemPrompt.section({
    name: 'tool:decision',
    order: 106,
    text: 'Plan the task, then call `decision_run` once with its objective, ordered plan with completion conditions, and environment or API endpoint. '
      + 'The executor owns observation, decisions, actions and completion checks; do not relay state or perform intermediate actions yourself. '
      + 'The small model executes within the supplied plan. Verify the final result after it returns; do not intervene between steps. '
      + 'It returns the final score/result, plan progress or an escalation. For an individual choice, the decision layer answers with a finite candidate set: call '
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
