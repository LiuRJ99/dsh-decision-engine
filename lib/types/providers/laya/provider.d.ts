/**
 * LayaDecisionProvider — the first Decision Provider.
 *
 * It is a translation layer and nothing more: it takes the model-agnostic
 * {@link DecisionRequest}, asks Laya, and returns the model-agnostic
 * {@link DecisionResult}. Everything Laya-specific lives behind this file and
 * its siblings in `providers/laya/`: the SDK, the ONNX session, the
 * `choice`/`score`/`noul` question types, `criteria`, `instructions`,
 * `probabilities`, and `rl_agent`.
 *
 * Nothing in `core/`, `runtime/`, `environments/`, or `tools/` imports this
 * module. Deleting the whole `providers/laya/` directory leaves the rest of
 * the project compiling and working — the acceptance test for the boundary.
 *
 * @module dsh-decision-engine/providers/laya/provider
 */
import type { DecisionCapability, DecisionContext, DecisionProvider, DecisionRequest, DecisionResult, ProviderHealth } from '../../core/types.ts';
import type { LayaConfig } from './config.ts';
import { LayaRuntime, type LayaRuntimeOptions } from './runtime.ts';
/**
 * The provider.
 *
 * Capabilities are declared, not discovered: a request in a mode this provider
 * does not implement is refused by the engine before any inference runs.
 */
export declare class LayaDecisionProvider implements DecisionProvider {
    #private;
    readonly id: string;
    readonly capabilities: readonly DecisionCapability[];
    constructor(options?: {
        id?: string;
        config?: LayaConfig;
        runtime?: LayaRuntime;
    } & Omit<LayaRuntimeOptions, 'config'>);
    /** The underlying runtime, for diagnostics. */
    get runtime(): LayaRuntime;
    /**
     * Answer one decision request.
     *
     * @throws DecisionError with `provider_unavailable`, `provider_timeout`,
     *   `aborted`, `invalid_decision`, or `provider_failed`.
     */
    decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult>;
    /**
     * Report runtime health.
     *
     * `offline` (the SDK is not installed) is `degraded`, not `unavailable`: the
     * provider is not usable for decisions but the deployment is intentional.
     * The distinction lets a caller choose a fallback provider without treating
     * the whole layer as broken.
     */
    healthCheck(): Promise<ProviderHealth>;
    /** Release the ONNX session. */
    dispose(): Promise<void>;
}
//# sourceMappingURL=provider.d.ts.map