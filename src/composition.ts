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
 * 1. Laya is supplied to the generic assembly as a ProviderSpec. Deleting
 *    `providers/laya/` leaves everything in
 *    `core/`, `runtime/`, `environments/`, or `tools/`.
 * 2. Environments are built over an injected {@link ToolDispatcher}, never over
 *    a concrete transport. Whether that dispatcher is the host tool registry or
 *    a test map is the caller's decision, so the capability gate stays outside
 *    this layer.
 *
 * @module dsh-decision-engine/composition
 */

import z from '@deepseek-ai/schemastery'
import { aggregateDecisionHealth, assembleDecisionCore, type ProviderSpec } from './assembly.ts'
import type { DecisionEngine } from './core/decision-engine.ts'
import { DecisionError } from './core/errors.ts'
import type { DecisionProviderRegistry } from './core/provider-registry.ts'
import { createRingBufferSink, type DecisionTelemetry } from './core/telemetry.ts'
import { EnvironmentRegistry } from './environments/registry.ts'
import { BrowserEnvironmentAdapter, type BrowserActionCandidate } from './environments/browser/adapter.ts'
import { ComputerEnvironmentAdapter, type ComputerAdapterConfig, type ComputerSeam } from './environments/computer/adapter.ts'
import type { ToolDispatcher } from './environments/dispatch.ts'
import type { DecisionRuntime, RuntimeConfigInput } from './runtime/runner.ts'
import { LayaConfigSchema, type LayaConfig } from './providers/laya/config.ts'
import { createLayaProviderSpec } from './providers/laya/index.ts'
import type { DecisionEngineService } from './service.ts'

export type { ProviderSpec } from './assembly.ts'

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
  /**
   * Per-provider settings, keyed by provider id.
   *
   * `laya` remains here for compatibility with existing settings. Other
   * provider plugins own their private settings and register at runtime.
   * The index signature preserves user-editable provider keys.
   */
  providers?: {
    /**
     * The provider's own settings. Laya validates these in its module;
     * `LayaConfig` is the precise shape.
     */
    laya?: Record<string, unknown>
    [providerId: string]: Record<string, unknown> | undefined
  }
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
  includeNonSemantic?: boolean
  candidateSelector?: string
  /** Whether the browser environment is registered. Defaults to true. */
  enabled?: boolean
  /** Environment id to register it under. Defaults to `browser`. */
  environmentId?: string
  /** Hard cap on derived candidates. */
  maxCandidates?: number
  /** Hard cap on characters of page text placed into the decision state. */
  maxStateChars?: number
  /**
   * Non-empty candidate set. When supplied the adapter runs in `patch` strategy
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
/**
 * The plugin's configuration schema.
 *
 * Three uses at once, which is why it lives here rather than in `plugin.ts`:
 *
 * 1. the loader validates `cordis.patch.yml` against it;
 * 2. `ctx.settings.register` validates and resolves host settings. The Web
 *    settings card is registered separately by the client entry;
 * 3. `createDecisionEngineComposition` reads the defaults from it.
 *
 * `providers.laya` is the compatibility path for the bundled local model.
 * Independently mounted providers validate their own settings namespace.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description(
    'Whether the decision layer is active at all. Turning this off removes the tool and stops answering decisions.',
  ),
  defaultProvider: z.string().description(
    'Provider id used when a request does not name one (for example "laya"). Omit it to use the first enabled provider.',
  ),
  providers: z.object({
    laya: LayaConfigSchema,
  }).description('Bundled Laya settings. Independently mounted providers own their settings namespace.'),
  runtime: z.object({
    maxSteps: z.number().default(10).description(
      'Hard step limit for one bounded loop. The run escalates instead of exceeding it.',
    ),
    maxDurationMs: z.number().default(120_000).description(
      'Hard wall-clock limit for one bounded loop, in milliseconds.',
    ),
    confidenceThreshold: z.number().default(0.55).description(
      'Confidence floor, applied ONLY to decisions whose provider declares confidenceKind "normalized". '
      + 'A provider reporting its own scale (provider_raw) or none (unavailable) is never compared with it.',
    ),
    noProgressLimit: z.number().default(3).description(
      'Stop a loop after this many consecutive steps in which the environment state did not change.',
    ),
    repeatedDecisionLimit: z.number().default(3).description(
      'Stop a loop after the same candidate is chosen this many times in a row.',
    ),
    observeTimeoutMs: z.number().default(90_000).description(
      'Budget for one observation, and the default provider budget for a single decision, in milliseconds.',
    ),
    executeTimeoutMs: z.number().default(90_000).description(
      'Budget for executing one environment action, in milliseconds.',
    ),
    stepDelayMs: z.number().default(0).description(
      'Pause between loop steps, in milliseconds, so a page or app can settle.',
    ),
    stateFingerprintChars: z.number().default(2_000).description(
      'How many characters of environment state are compared to detect "no progress".',
    ),
    singleCandidateSteps: z.union([z.const('ask'), z.const('execute')]).default('ask').description(
      'What to do when a step offers exactly one candidate: ask the provider (default), or take it directly. '
      + 'Stage scopes that narrow to a single control need "execute" — there is nothing to decide, and a small local head fails on it.',
    ),
  }).description('Budgets and stop conditions shared by every environment.'),
  browser: z.object({
    includeNonSemantic: z.boolean().default(false).description('Opt in to inferred clickable elements. Requires browser workspace v0.1.10 or newer.'),
    candidateSelector: z.string().description('CSS selector limiting inventory candidates before size caps. Prefer task-local overrides for site-specific selectors.'),
    enabled: z.boolean().default(true).description('Whether the browser environment is available to the decision layer.'),
    environmentId: z.string().description('Environment id to register it under. Defaults to "browser".'),
    maxCandidates: z.number().description('Maximum number of page controls offered to the decider. Defaults to 12.'),
    maxStateChars: z.number().description('How much page text is placed into the decision state. Defaults to 6000.'),
    candidates: z.array(z.any()).description(
      'Non-empty fixed candidate set. An empty list uses controls derived from the page.',
    ),
  }).description('Observes pages through the registered browser_* tools. Plain text only: never reads a screenshot.'),
  computer: z.object({
    enabled: z.boolean().default(true).description('Whether the desktop (accessibility) environment is available.'),
    environmentId: z.string().description('Environment id to register it under. Defaults to "computer".'),
    app: z.string().description(
      'Target app: bundle id, display name, or path. Take it from computer_use_list_apps. '
      + 'A display name often fails where the bundle id works.',
    ),
    maxCandidates: z.number().description('Maximum number of accessibility elements offered to the decider. Defaults to 12.'),
    maxStateChars: z.number().description('How much accessibility-tree text is placed into the decision state. Defaults to 8000.'),
    maxTreeNodes: z.number().description('Maximum accessibility nodes captured per observation. Defaults to 1200.'),
    captureTimeoutMs: z.number().description(
      'How long to wait for one accessibility capture before reporting it as unusable. Defaults to 30000. '
      + 'A capture can block on a permission prompt, and a loop must not wait forever.',
    ),
  }).description('Drives apps through the accessibility tree. Never reads a screenshot and never infers coordinates from pixels.'),
  telemetryLimit: z.number().default(200).description(
    'How many recent telemetry records are kept in memory for diagnostics. Records hold counts, ids and timings — never page text or tree content.',
  ),
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
  /** Provider instances supplied by the caller, alongside the local Laya adapter. */
  providers?: readonly ProviderSpec[]
  /** @deprecated Use `providers`. Kept for existing embedders. */
  extraProviders?: readonly ProviderSpec[]
  /** Host boot may wait for an independently mounted provider plugin. */
  deferMissingDefault?: boolean
}): DecisionEngineComposition {
  const config = options.config ?? {}
  const { sink, records } = createRingBufferSink(config.telemetryLimit ?? 200)

  const environments = new EnvironmentRegistry()
  if (config.browser?.enabled ?? true) {
    const browserCandidates = config.browser?.candidates as BrowserActionCandidate[] | undefined
    // Schemastery resolves an omitted array to []; that is not a patch.
    const hasBrowserPatch = browserCandidates !== undefined && browserCandidates.length > 0
    environments.register(new BrowserEnvironmentAdapter({
      ...config.browser?.environmentId === undefined ? {} : { id: config.browser.environmentId },
      dispatcher: options.dispatcher,
      config: {
        strategy: hasBrowserPatch ? 'patch' : 'form',
        ...config.browser?.includeNonSemantic === undefined ? {} : { includeNonSemantic: config.browser.includeNonSemantic },
        ...config.browser?.candidateSelector === undefined ? {} : { candidateSelector: config.browser.candidateSelector },
        ...hasBrowserPatch ? { candidates: browserCandidates } : {},
        ...config.browser?.maxCandidates === undefined ? {} : { maxCandidates: config.browser.maxCandidates },
        ...config.browser?.maxStateChars === undefined ? {} : { maxStateChars: config.browser.maxStateChars },
      },
    }))
  }
  if (config.computer?.enabled ?? true) {
    const computerConfig: ComputerAdapterConfig = {
      ...config.computer?.app === undefined ? {} : { app: config.computer.app },
      ...config.computer?.maxCandidates === undefined ? {} : { maxCandidates: config.computer.maxCandidates },
      ...config.computer?.maxStateChars === undefined ? {} : { maxStateChars: config.computer.maxStateChars },
      ...config.computer?.maxTreeNodes === undefined ? {} : { maxTreeNodes: config.computer.maxTreeNodes },
      ...config.computer?.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: config.computer.captureTimeoutMs },
    }
    environments.register(new ComputerEnvironmentAdapter({
      ...config.computer?.environmentId === undefined ? {} : { id: config.computer.environmentId },
      ...options.computerSeam === undefined ? {} : { seam: options.computerSeam },
      dispatcher: options.dispatcher,
      config: computerConfig,
    }))
  }

  const layaConfig = (config.providers?.laya ?? {}) as LayaConfig
  const includeLaya = layaConfig.enabled !== false
    && (options.providers === undefined || config.providers?.laya !== undefined)
  const providerSpecs: ProviderSpec[] = [
    ...(includeLaya ? [createLayaProviderSpec(layaConfig)] : []),
    ...(options.providers ?? options.extraProviders ?? []),
  ]
  const disabledDefault = config.defaultProvider !== undefined
    && config.providers?.[config.defaultProvider]?.enabled === false
  const { providers, engine, runtime } = assembleDecisionCore({
    providers: providerSpecs,
    ...config.defaultProvider === undefined || disabledDefault ? {} : { defaultProvider: config.defaultProvider },
    ...options.deferMissingDefault === undefined ? {} : { deferMissingDefault: options.deferMissingDefault },
    ...config.runtime === undefined ? {} : { runtime: config.runtime },
    ...config.runtime?.confidenceThreshold === undefined ? {} : { confidenceThreshold: config.runtime.confidenceThreshold },
    ...config.runtime?.observeTimeoutMs === undefined ? {} : { timeoutMs: config.runtime.observeTimeoutMs },
    telemetry: sink,
    environments,
  })

  let requestedDefault = config.defaultProvider
  const setDefaultProvider = (requested?: string): void => {
    const isDisabled = requested !== undefined && config.providers?.[requested]?.enabled === false
    if (requested !== undefined && !providers.has(requested)
      && !isDisabled && !options.deferMissingDefault) {
      throw new DecisionError('provider_unknown', `defaultProvider "${requested}" is not registered`)
    }
    if (requested !== undefined && providers.entry(requested)?.enabled) {
      engine.reconfigure({ defaultProviderId: requested })
    } else if (requested !== undefined && !providers.has(requested) && !isDisabled && options.deferMissingDefault) {
      providers.deferDefault(requested)
    } else {
      engine.router.setDefaultProvider(undefined)
    }
    requestedDefault = requested
  }

  const service: DecisionEngineService = {
    engine,
    providers,
    environments,
    runtime,
    // Getters, so a settings change is visible immediately instead of leaving a
    // stale snapshot behind (the engine and runtime are reconfigured live).
    get confidenceThreshold(): number {
      return engine.confidenceThreshold
    },
    get runtimeConfig() {
      return runtime.resolveConfig()
    },
    decide: (request, decideOptions) => engine.decide(request, decideOptions),
    run: runOptions => runtime.run(runOptions),
    runTask: taskOptions => runtime.runTask(taskOptions),
    isCapabilityUnlocked: capability => options.readCapabilityGate?.(capability),
    health: () => aggregateDecisionHealth({ providers, environments, records,
      ...requestedDefault === undefined ? {} : { requestedDefault } }),
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
    setDefaultProvider,
    dispose: () => service.dispose(),
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
  /** Repoint the active default and retain a disabled requested id for health. */
  setDefaultProvider(id?: string): void
  dispose(): Promise<void>
}
