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
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { type ToolCallRequest, type ToolCallResult, type ToolDispatcher } from './environments/dispatch.ts';
import { type Config } from './composition.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "decision-engine";
/** Host services this plugin requires. Everything else is consumed opportunistically. */
export declare const inject: string[];
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
export declare class HostToolDispatcher implements ToolDispatcher {
    #private;
    constructor(ctx: Context, execution?: () => ToolRunContext | undefined);
    availableTools(): readonly string[];
    call(request: ToolCallRequest): Promise<ToolCallResult>;
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
 * Registering it is what makes the **built-in plugin settings panel** render this
 * plugin's configuration: the panel discovers namespaces from the settings
 * service and renders each one's schemastery schema, which is why every field in
 * `Config` carries a `.description()`. Nothing bespoke is needed here — the same
 * mechanism that renders the lazy gate's capability list renders this.
 */
export declare const SETTINGS_NAMESPACE: "decision-engine";
export declare function apply(ctx: Context, config?: Config): void;
/** Re-export the public surface so a plugin consumer imports one module. */
export { createDecisionEngineComposition } from './composition.ts';
export type { Config } from './composition.ts';
export * from './core/types.ts';
export * from './core/errors.ts';
export * from './core/telemetry.ts';
export * from './environments/types.ts';
export * from './runtime/runner.ts';
export * from './service.ts';
export { LayaDecisionProvider } from './providers/laya/provider.ts';
export { LayaRuntime } from './providers/laya/runtime.ts';
export type { LayaConfig } from './providers/laya/config.ts';
export { executeDecide, renderDecideOutput } from './tools/decide-logic.ts';
export { DECISION_CONTROL_SKILL, DECISION_CONTROL_SKILL_NAME } from './skill.ts';
export { GATE_SKILL_NAMES, queryCapabilityUnlocked, TOOL_LAZY_GATE_SERVICE } from './gate.ts';
//# sourceMappingURL=plugin.d.ts.map