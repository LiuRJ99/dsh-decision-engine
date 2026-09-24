/** Shared host-free construction for the DSH and embedded entry points. */
import { DecisionEngine } from './core/decision-engine.ts';
import { DecisionProviderRegistry } from './core/provider-registry.ts';
import type { DecisionTelemetry, DecisionTelemetrySink } from './core/telemetry.ts';
import type { DecisionProvider } from './core/types.ts';
import { EnvironmentRegistry } from './environments/registry.ts';
import { DecisionRuntime, type RuntimeConfigInput } from './runtime/runner.ts';
import type { DecisionEngineHealth } from './service.ts';
export interface ProviderSpec {
    provider: DecisionProvider;
    enabled?: boolean;
    config?: Record<string, unknown>;
}
export declare function assembleDecisionCore(options: {
    providers: readonly ProviderSpec[];
    defaultProvider?: string;
    deferMissingDefault?: boolean;
    runtime?: RuntimeConfigInput;
    confidenceThreshold?: number;
    timeoutMs?: number;
    telemetry: DecisionTelemetrySink;
    environments: EnvironmentRegistry;
}): {
    providers: DecisionProviderRegistry;
    engine: DecisionEngine;
    runtime: DecisionRuntime;
};
export declare function aggregateDecisionHealth(options: {
    providers: DecisionProviderRegistry;
    environments: EnvironmentRegistry;
    records: readonly DecisionTelemetry[];
    requestedDefault?: string;
}): Promise<DecisionEngineHealth>;
//# sourceMappingURL=assembly.d.ts.map