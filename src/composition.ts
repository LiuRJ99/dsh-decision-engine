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
  /**
   * Per-provider settings, keyed by provider id.
   *
   * `laya` is declared explicitly so the settings panel renders its fields
   * instead of an opaque dict; an additional provider family adds a sibling key.
   * The index signature keeps an unknown provider id representable, because the
   * file-backed settings document is user-editable and forward compatibility
   * matters more here than a closed type.
   */
  providers?: {
    /**
     * The provider's own settings. Typed loosely here because the schema above
     * describes these fields generically (it must not carry provider
     * vocabulary); `LayaConfig` is the precise shape and
     * `resolveLayaConfig` is what validates and defaults it.
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
/**
 * The plugin's configuration schema.
 *
 * Three uses at once, which is why it lives here rather than in `plugin.ts`:
 *
 * 1. the loader validates `cordis.patch.yml` against it;
 * 2. `ctx.settings.register` uses it to render the **plugin settings panel** —
 *    every `.description()` below is the help text that panel shows, so a field
 *    without one is a field a user has to guess at;
 * 3. `createDecisionEngineComposition` reads the defaults from it.
 *
 * `providers` stays a dict because provider-private settings belong under
 * `providers.<id>` — a second model family adds a key, not a schema field.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description(
    'Whether the decision layer is active at all. Turning this off removes the tool and stops answering decisions.',
  ),
  defaultProvider: z.string().description(
    'Provider id used when a request does not name one (for example "laya"). Leave empty to use the first enabled provider.',
  ),
  providers: z.object({
    // A named sub-object rather than a dict on purpose: a dict renders as an
    // opaque `{}` in the settings panel, which would hide every provider knob
    // (model path, residency, device) behind a hand-edited YAML file. A second
    // provider family adds a sibling key here — provider-private settings still
    // live under `providers.<id>`, never as top-level fields.
    laya: z.object({
      enabled: z.boolean().default(true).description('Whether the Laya provider is registered. Turn off to run the layer without a model.'),
      modelDir: z.string().description(
        'Directory holding laya.onnx, laya.onnx.data, laya_config.json and tokenizer/. '
        + 'Setting it skips the SDK freshness check and its download entirely, which is required on a machine whose cache is not writable.',
      ),
      device: z.string().default('cpu').description('ONNX execution provider: cpu, coreml, cuda, dml or wasm — or a comma-separated list.'),
      threads: z.number().description('intraOpNumThreads override. 0 leaves the runtime default.'),
      autoLoad: z.boolean().default(false).description(
        'Load the model at startup instead of on the first decision. Off by default: a session pins the weights (about 1.6 GB) for as long as it is open.',
      ),
      idleTtlMs: z.number().default(0).description(
        'Release the model after this many milliseconds without a decision; the next decision reloads it. 0 keeps it resident for the process lifetime.',
      ),
      required: z.boolean().default(false).description('Treat an unavailable model as a hard failure instead of reporting the provider as degraded.'),
      strictCandidates: z.boolean().default(true).description('Refuse a model answer that names an option which was not on the ballot.'),
      // Deliberately a plain string, not the provider's own union: naming its
      // literals here would put provider vocabulary in the neutral composition
      // root, which is exactly the coupling this project exists to avoid.
      // `resolveLayaConfig` validates the value; this schema only renders it.
      classificationBinaryMode: z.string().default('choice').description(
        'How a two-option classification is asked when the provider supports a binary head; '
        + 'see the provider documentation for the accepted values.',
      ),
      scoreLevels: z.array(z.string()).description('Rating scale for ranking and score modes, lowest first.'),
      scoringMode: z.string().default('per-candidate').description('Ratings strategy: "per-candidate" rates every option.'),
      timeoutMs: z.number().default(30_000).description('Per-call budget hint in milliseconds.'),
      maxStateChars: z.number().default(20_000).description('Maximum characters of serialized state sent to the model.'),
    }).description('Laya: the first Decision Provider. Everything here is Laya-private.'),
  }).description('Per-provider settings, keyed by provider id. Provider-private fields live here, never as top-level keys.'),
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
    singleCandidateSteps: z.union([z.const('ask'), z.const('execute')]).default('execute').description(
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
      'Fixed candidate set. When set, the adapter offers exactly these instead of deriving them from the page.',
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
        ...config.browser?.includeNonSemantic === undefined ? {} : { includeNonSemantic: config.browser.includeNonSemantic },
        ...config.browser?.candidateSelector === undefined ? {} : { candidateSelector: config.browser.candidateSelector },
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
      await service.dispose()
      for (const dispose of disposers.reverse()) dispose()
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
