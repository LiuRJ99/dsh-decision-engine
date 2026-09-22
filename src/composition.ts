/**
 * The decision-engine composition root — host-free.
 *
 * Everything that can be assembled without a DSH process lives here: build one
 * engine, register the providers the config enables, build the environment
 * adapters, and construct the bounded runtime. `plugin.ts` adds the host
 * wiring on top (the tool dispatcher, the tool registration, the skill, and
 * `ctx.decisionEngine`).
 *
 * Two invariants this file owns:
 *
 * 1. The Laya provider is constructed here and nowhere else. Deleting
 *    `providers/laya/` breaks exactly this file's import and nothing in
 *    `core/`, `runtime/`, `environments/`, or `tools/`.
 * 2. Environments are built over an injected {@link ToolDispatcher}, never over
 *    a concrete transport. Whether that dispatcher is the host tool registry or
 *    a test map is the caller's decision, so the capability gate stays outside
 *    this layer.
 *
 * @module dsh-decision-engine/composition
 */

import z from '@deepseek-ai/schemastery'
import { DecisionEngine } from './core/decision-engine.ts'
import { DecisionProviderRegistry } from './core/provider-registry.ts'
import { DecisionError } from './core/errors.ts'
import { createRingBufferSink, type DecisionTelemetry, type DecisionTelemetrySink } from './core/telemetry.ts'
import type { DecisionProvider } from './core/types.ts'
import { EnvironmentRegistry } from './environments/registry.ts'
import { BrowserEnvironmentAdapter, type BrowserActionCandidate } from './environments/browser/adapter.ts'
import { ComputerEnvironmentAdapter, type ComputerAdapterConfig, type ComputerSeam } from './environments/computer/adapter.ts'
import type { ToolDispatcher } from './environments/dispatch.ts'
import { DecisionRuntime, type RuntimeConfigInput } from './runtime/runner.ts'
import { LayaDecisionProvider } from './providers/laya/provider.ts'
import type { LayaConfig } from './providers/laya/config.ts'
import type { DecisionEngineHealth, DecisionEngineService } from './service.ts'

/**
 * Plugin configuration. Mirrors the documented shape:
 *
 * ```yaml
 * decisionEngine:
 *   enabled: true
 *   defaultProvider: laya
 *   providers:
 *     laya:
 *       enabled: true
 *       modelDir: /path/to/bundle
 *   runtime:
 *     confidenceThreshold: 0.55
 *     maxSteps: 10
 *   browser:
 *     enabled: true
 *   computer:
 *     enabled: true
 * ```
 *
 * Provider-private settings live under `providers.<id>` — `providers.laya` —
 * never as top-level keys, so a second provider cannot collide with the first.
 */
export interface Config {
  /** Whether the plugin wires anything at all. Defaults to true. */
  enabled?: boolean
  /** Provider id used when a request does not name one. Defaults to the first enabled provider. */
  defaultProvider?: string
  /** Per-provider settings, keyed by provider id. */
  providers?: Record<string, Record<string, unknown>>
  /** Runtime budgets and stop conditions. */
  runtime?: RuntimeConfigInput
  /** Browser environment settings. */
  browser?: BrowserEnvironmentConfig
  /** Computer environment settings. */
  computer?: ComputerEnvironmentConfig
  /** Number of telemetry records kept in memory. Defaults to 200. */
  telemetryLimit?: number
}

/** Browser environment config, as read from `decisionEngine.browser`. */
export interface BrowserEnvironmentConfig {
  /** Whether the browser environment is registered. Defaults to true. */
  enabled?: boolean
  /** Environment id to register it under. Defaults to `browser`. */
  environmentId?: string
  /** Hard cap on derived candidates. */
  maxCandidates?: number
  /** Hard cap on characters of page text placed into the decision state. */
  maxStateChars?: number
  /**
   * Explicit candidate set. When present the adapter runs in `patch` strategy
   * and offers exactly these candidates instead of deriving them from the page.
   * Validated by the browser adapter at registration time.
   */
  candidates?: unknown[]
}

/** Computer environment config, as read from `decisionEngine.computer`. */
export interface ComputerEnvironmentConfig {
  /** Whether the computer environment is registered. Defaults to true. */
  enabled?: boolean
  /** Environment id to register it under. Defaults to `computer`. */
  environmentId?: string
  /** Target app identifier. Omit until an app is chosen. */
  app?: string
  /** Hard cap on derived candidates. */
  maxCandidates?: number
  /** Hard cap on characters of AX text placed into the decision state. */
  maxStateChars?: number
  /** Maximum accessibility-tree nodes to capture. */
  maxTreeNodes?: number
  /** How long to wait for one accessibility capture before giving up, in milliseconds. */
  captureTimeoutMs?: number
}

/** One configurable candidate for the browser adapter's patch strategy. */
export type { BrowserActionCandidate }


/** Schemastery schema, so the loader validates and defaults the config. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  defaultProvider: z.string(),
  providers: z.dict(z.object({})),
  runtime: z.object({
    maxSteps: z.number().default(10),
    maxDurationMs: z.number().default(120_000),
    confidenceThreshold: z.number().default(0.55),
    noProgressLimit: z.number().default(3),
    repeatedDecisionLimit: z.number().default(3),
    observeTimeoutMs: z.number().default(90_000),
    executeTimeoutMs: z.number().default(90_000),
    stepDelayMs: z.number().default(0),
    stateFingerprintChars: z.number().default(2_000),
  }),
  browser: z.object({
    enabled: z.boolean().default(true),
    environmentId: z.string(),
    maxCandidates: z.number(),
    maxStateChars: z.number(),
    candidates: z.array(z.any()),
  }),
  computer: z.object({
    enabled: z.boolean().default(true),
    environmentId: z.string(),
    app: z.string(),
    maxCandidates: z.number(),
    maxStateChars: z.number(),
    maxTreeNodes: z.number(),
    captureTimeoutMs: z.number(),
  }),
  telemetryLimit: z.number().default(200),
})


/**
 * Build the whole composition without touching Cordis.
 *
 * Exported so tests and embedders can assemble the layer with their own
 * dispatcher — and so the host-facing `plugin.ts` stays a thin adapter.
 */
export function createDecisionEngineComposition(options: {
  config?: Config
  dispatcher: ToolDispatcher
  /** In-process computer seam, when the computer-use plugin is mounted. */
  computerSeam?: ComputerSeam
  /** Read-only capability-gate query. */
  readCapabilityGate?: (capability: 'browser' | 'computer') => boolean | undefined
  /** Extra providers to register after the built-in ones. */
  extraProviders?: Array<{ provider: DecisionProvider; enabled?: boolean; config?: Record<string, unknown> }>
}): DecisionEngineComposition {
  const config = options.config ?? {}
  const { sink, records } = createRingBufferSink(config.telemetryLimit ?? 200)
  const telemetry: DecisionTelemetrySink = sink

  const providers = new DecisionProviderRegistry()
  const layaConfig = (config.providers?.laya ?? {}) as LayaConfig
  const layaEnabled = layaConfig.enabled ?? true
  const disposers: Array<() => void> = []
  // The Laya provider is registered HERE and nowhere else. That single fact is
  // what makes `import` direction enforceable: core, runtime, environments, and
  // tools never mention it, so deleting providers/laya/ cannot break them.
  if (layaEnabled) {
    disposers.push(providers.register(new LayaDecisionProvider({ config: layaConfig }), {
      enabled: true,
      config: { ...layaConfig },
    }))
  }
  for (const extra of options.extraProviders ?? []) {
    disposers.push(providers.register(extra.provider, {
      ...extra.enabled === undefined ? {} : { enabled: extra.enabled },
      ...extra.config === undefined ? {} : { config: extra.config },
    }))
  }

  const configuredDefault = config.defaultProvider
  if (configuredDefault !== undefined && providers.has(configuredDefault)) {
    const entry = providers.entry(configuredDefault)
    if (entry?.enabled === true) providers.setDefault(configuredDefault)
  } else if (configuredDefault !== undefined) {
    // Naming a provider that is not registered is a configuration mistake worth
    // failing on: it can only happen if nothing provides that id.
    throw new DecisionError('provider_unknown', `defaultProvider "${configuredDefault}" is not a registered provider.`, {
      subject: configuredDefault,
      details: { registered: providers.ids() },
    })
  }
  // A registered-but-disabled default is not fatal: the deployment deliberately
  // turned that provider off, so the registry's own first-enabled fallback
  // applies. The mismatch stays visible through `health()`.
  const requestedDefault = configuredDefault

  const engine = new DecisionEngine({
    ...configuredDefault === undefined ? {} : { defaultProviderId: configuredDefault },
    ...config.runtime?.confidenceThreshold === undefined ? {} : { confidenceThreshold: config.runtime.confidenceThreshold },
    ...config.runtime?.observeTimeoutMs === undefined ? {} : { timeoutMs: config.runtime.observeTimeoutMs },
    telemetry,
  }, providers)

  const environments = new EnvironmentRegistry()
  if (config.browser?.enabled ?? true) {
    const browserCandidates = config.browser?.candidates as BrowserActionCandidate[] | undefined
    disposers.push(environments.register(new BrowserEnvironmentAdapter({
      ...config.browser?.environmentId === undefined ? {} : { id: config.browser.environmentId },
      dispatcher: options.dispatcher,
      config: {
        strategy: browserCandidates === undefined ? 'form' : 'patch',
        ...browserCandidates === undefined ? {} : { candidates: browserCandidates },
        ...config.browser?.maxCandidates === undefined ? {} : { maxCandidates: config.browser.maxCandidates },
        ...config.browser?.maxStateChars === undefined ? {} : { maxStateChars: config.browser.maxStateChars },
      },
    })))
  }
  if (config.computer?.enabled ?? true) {
    const computerConfig: ComputerAdapterConfig = {
      ...config.computer?.app === undefined ? {} : { app: config.computer.app },
      ...config.computer?.maxCandidates === undefined ? {} : { maxCandidates: config.computer.maxCandidates },
      ...config.computer?.maxStateChars === undefined ? {} : { maxStateChars: config.computer.maxStateChars },
      ...config.computer?.maxTreeNodes === undefined ? {} : { maxTreeNodes: config.computer.maxTreeNodes },
      ...config.computer?.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: config.computer.captureTimeoutMs },
    }
    disposers.push(environments.register(new ComputerEnvironmentAdapter({
      ...config.computer?.environmentId === undefined ? {} : { id: config.computer.environmentId },
      ...options.computerSeam === undefined ? {} : { seam: options.computerSeam },
      dispatcher: options.dispatcher,
      config: computerConfig,
    })))
  }

  const runtime = new DecisionRuntime(engine, {
    ...config.runtime === undefined ? {} : { config: config.runtime },
    telemetry,
    environments,
  })

  const service: DecisionEngineService = {
    engine,
    providers,
    environments,
    runtime,
    confidenceThreshold: engine.confidenceThreshold,
    runtimeConfig: runtime.resolveConfig(),
    decide: (request, decideOptions) => engine.decide(request, decideOptions),
    run: runOptions => runtime.run(runOptions),
    isCapabilityUnlocked: capability => options.readCapabilityGate?.(capability),
    health: async (): Promise<DecisionEngineHealth> => {
      const providerHealth = await providers.health()
      const statuses = Object.values(providerHealth).map(entry => entry.status)
      const status = statuses.length === 0 || statuses.every(entry => entry === 'unavailable')
        ? 'unavailable'
        : statuses.every(entry => entry === 'ok')
          ? 'ok'
          : 'degraded'
      const defaultProvider = providers.getDefaultId()
      return {
        status,
        ...defaultProvider === undefined ? {} : { defaultProvider },
        ...requestedDefault === undefined || requestedDefault === defaultProvider
          ? {}
          : { requestedDefaultProvider: requestedDefault },
        providers: providerHealth,
        environments: environments.ids(),
        telemetryRecords: records.length,
      }
    },
    telemetry: () => records,
    dispose: async () => {
      await environments.disposeAll()
      await providers.disposeAll()
    },
  }

  return {
    service,
    engine,
    providers,
    environments,
    runtime,
    telemetryRecords: records,
    dispose: async () => {
      for (const dispose of disposers.reverse()) dispose()
      await service.dispose()
    },
  }
}

/** The full composition, so callers and tests can reach every part directly. */
export interface DecisionEngineComposition {
  service: DecisionEngineService
  engine: DecisionEngine
  providers: DecisionProviderRegistry
  environments: EnvironmentRegistry
  runtime: DecisionRuntime
  telemetryRecords: DecisionTelemetry[]
  dispose(): Promise<void>
}
