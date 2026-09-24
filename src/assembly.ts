/** Shared host-free construction for the DSH and embedded entry points. */
import { DecisionEngine } from './core/decision-engine.ts'
import { DecisionError } from './core/errors.ts'
import { DecisionProviderRegistry } from './core/provider-registry.ts'
import type { DecisionTelemetry, DecisionTelemetrySink } from './core/telemetry.ts'
import type { DecisionProvider, ProviderHealth } from './core/types.ts'
import { EnvironmentRegistry } from './environments/registry.ts'
import { DecisionRuntime, type RuntimeConfigInput } from './runtime/runner.ts'
import type { DecisionEngineHealth } from './service.ts'

export interface ProviderSpec {
  provider: DecisionProvider
  enabled?: boolean
  config?: Record<string, unknown>
}

export function assembleDecisionCore(options: {
  providers: readonly ProviderSpec[]
  defaultProvider?: string
  deferMissingDefault?: boolean
  runtime?: RuntimeConfigInput
  confidenceThreshold?: number
  timeoutMs?: number
  telemetry: DecisionTelemetrySink
  environments: EnvironmentRegistry
}): { providers: DecisionProviderRegistry; engine: DecisionEngine; runtime: DecisionRuntime } {
  const providers = new DecisionProviderRegistry()
  for (const entry of options.providers) {
    providers.register(entry.provider, {
      ...entry.enabled === undefined ? {} : { enabled: entry.enabled },
      ...entry.config === undefined ? {} : { config: entry.config },
    })
  }

  const requested = options.defaultProvider
  if (requested !== undefined) {
    const entry = providers.entry(requested)
    if (entry === undefined && !options.deferMissingDefault) {
      throw new DecisionError('provider_unknown', `defaultProvider "${requested}" is not a registered provider.`, {
        subject: requested,
        details: { registered: providers.ids() },
      })
    }
    if (entry?.enabled) providers.setDefault(requested)
    else if (entry === undefined && options.deferMissingDefault) providers.deferDefault(requested)
  }
  // A disabled requested default remains visible in health, while routing uses
  // the first enabled provider. The registry is the source of that active id.
  const active = providers.getDefaultId()
  const engine = new DecisionEngine({
    ...active === undefined ? {} : { defaultProviderId: active },
    ...options.confidenceThreshold === undefined ? {} : { confidenceThreshold: options.confidenceThreshold },
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    telemetry: options.telemetry,
  }, providers)
  const runtime = new DecisionRuntime(engine, {
    ...options.runtime === undefined ? {} : { config: options.runtime },
    environments: options.environments,
  })
  return { providers, engine, runtime }
}

export async function aggregateDecisionHealth(options: {
  providers: DecisionProviderRegistry
  environments: EnvironmentRegistry
  records: readonly DecisionTelemetry[]
  requestedDefault?: string
}): Promise<DecisionEngineHealth> {
  const providerHealth = await options.providers.health()
  const statuses = Object.values(providerHealth).map((entry: ProviderHealth) => entry.status)
  const providerStatus = statuses.length === 0 || statuses.every(entry => entry === 'unavailable')
    ? 'unavailable'
    : statuses.every(entry => entry === 'ok')
      ? 'ok'
      : 'degraded'
  const status = providerStatus === 'unavailable' ? providerStatus
    : options.providers.getPendingDefaultId() === undefined ? providerStatus : 'degraded'
  const defaultProvider = options.providers.getDefaultId()
  return {
    status,
    ...defaultProvider === undefined ? {} : { defaultProvider },
    ...options.requestedDefault === undefined || options.requestedDefault === defaultProvider
      ? {} : { requestedDefaultProvider: options.requestedDefault },
    providers: providerHealth,
    environments: options.environments.ids(),
    telemetryRecords: options.records.length,
  }
}
