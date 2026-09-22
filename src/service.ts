/**
 * The plugin's public host service: `ctx.decisionEngine`.
 *
 * This is the seam another plugin uses to get a decision without going through
 * the model-facing tool. It exposes the engine, the registries, the runtime,
 * and the diagnostics a caller needs — and nothing else. Environments are not
 * exposed, because reaching an environment is the runtime's job; providers are
 * exposed only through their registry, because registering one is how a new
 * model family plugs in.
 *
 * @module dsh-decision-engine/src/service
 */

import type { DecisionEngine, EngineDecideOptions } from './core/decision-engine.ts'
import type { DecisionProviderRegistry } from './core/provider-registry.ts'
import type { DecisionRequest, DecisionResult, ProviderHealth } from './core/types.ts'
import type { EnvironmentRegistry } from './environments/registry.ts'
import type { DecisionRuntime, RunOptions, RuntimeOutcome } from './runtime/runner.ts'
import type { DecisionTelemetry } from './core/telemetry.ts'

/** Health of the whole layer, as reported to a host or a diagnostic tool. */
export interface DecisionEngineHealth {
  status: 'ok' | 'degraded' | 'unavailable'
  /** The provider routing actually uses. */
  defaultProvider?: string
  /**
   * The provider the config named, when it differs from the active default
   * (typically because that provider is registered but disabled).
   */
  requestedDefaultProvider?: string
  providers: Record<string, ProviderHealth>
  environments: string[]
  telemetryRecords: number
}

/**
 * What `ctx.decisionEngine` offers.
 */
export interface DecisionEngineService {
  /** The engine. `decide(request)` is the one entry point. */
  readonly engine: DecisionEngine
  /** Provider membership and lookup. */
  readonly providers: DecisionProviderRegistry
  /** Environment membership and lookup. */
  readonly environments: EnvironmentRegistry
  /** The bounded runtime that drives an environment. */
  readonly runtime: DecisionRuntime
  /**
   * The confidence floor currently applied to acting decisions.
   *
   * A getter, not a snapshot: the floor is editable at runtime through the
   * plugin settings, and a stored value would keep reporting the value the
   * process started with.
   */
  readonly confidenceThreshold: number
  /** The runtime budgets currently in force. A getter for the same reason. */
  readonly runtimeConfig: import('./runtime/runner.ts').RuntimeConfig
  /** Decide, forwarding to the engine. */
  decide(request: DecisionRequest, options?: EngineDecideOptions): Promise<DecisionResult>
  /** Drive an environment through the runtime. */
  run(options: RunOptions): Promise<RuntimeOutcome>
  /** Whether a capability family is unlocked for this session, when a gate is mounted. */
  isCapabilityUnlocked(capability: 'browser' | 'computer'): boolean | undefined
  /** Aggregate health. */
  health(): Promise<DecisionEngineHealth>
  /** The most recent telemetry records, newest last. */
  telemetry(): readonly DecisionTelemetry[]
  /** Stop the runtime's providers and adapters. */
  dispose(): Promise<void>
}
