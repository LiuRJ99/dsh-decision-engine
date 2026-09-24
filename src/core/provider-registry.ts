/**
 * Provider registry: the pluggable, replaceable, closable, routable set of
 * decision models the engine may reach.
 *
 * Registration is the only way a provider becomes reachable, and lookup is by
 * id. The registry never imports a concrete provider, so adding a second model
 * family is `register(...)` plus config — nothing in the engine, the
 * environments, or the runtime changes.
 *
 * @module dsh-decision-engine/core/provider-registry
 */

import { DecisionError } from './errors.ts'
import { isDecisionCapability, type DecisionCapability, type DecisionContext, type DecisionProvider, type DecisionMode, type DecisionRequest, type DecisionResult, type ProviderHealth } from './types.ts'

/** One registry entry: the provider plus how it is enabled. */
export interface ProviderRegistration {
  provider: DecisionProvider
  /** Whether the provider participates in routing. A disabled provider stays registered but unroutable. */
  enabled: boolean
  /** Free-form provider config, owned by the provider's own module. */
  config: Record<string, unknown>
}

/** Snapshot of one registered provider, for listing and diagnostics. */
export interface ProviderDescriptor {
  id: string
  enabled: boolean
  capabilities: readonly DecisionCapability[]
  /** Whether the provider exposes a health check. */
  hasHealthCheck: boolean
  /** Whether the provider is the registry's current default. */
  isDefault: boolean
}

/** Options accepted by {@link DecisionProviderRegistry.register}. */
export interface RegisterOptions {
  /** Defaults to true. A disabled provider is registered but never routed to. */
  enabled?: boolean
  /** Provider-owned config. Stored verbatim; the provider reads it itself. */
  config?: Record<string, unknown>
  /**
   * Replace a provider already registered under the same id.
   * Defaults to false so an accidental double registration fails loudly.
   */
  replace?: boolean
}

/**
 * The registry. One instance per engine; the engine owns routing policy, the
 * registry owns membership.
 */
export class DecisionProviderRegistry {
  readonly #entries = new Map<string, ProviderRegistration>()
  #defaultId: string | undefined
  #pendingDefaultId: string | undefined
  #pinnedDefaultId: string | undefined

  /**
   * Add a provider.
   *
   * @param provider - the provider instance. Its `id` becomes the registry key.
   * @param options - enablement and config.
   * @returns the exact disposer that unregisters this provider.
   * @throws DecisionError with `invalid_request` on a malformed id or a duplicate.
   */
  register(provider: DecisionProvider, options: RegisterOptions = {}): () => void {
    const id = provider?.id
    if (typeof id !== 'string' || id.trim() === '') {
      throw new DecisionError('invalid_request', 'A decision provider must declare a non-empty string id.')
    }
    if (typeof provider.decide !== 'function') {
      throw new DecisionError('invalid_request', `Provider "${id}" must implement decide().`, { subject: id })
    }
    const capabilities = provider.capabilities
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new DecisionError('invalid_request', `Provider "${id}" must declare at least one capability.`, { subject: id })
    }
    for (const capability of capabilities) {
      if (!isDecisionCapability(capability)) {
        throw new DecisionError('invalid_request', `Provider "${id}" declares unknown capability "${String(capability)}".`, {
          subject: id,
          details: { capability: String(capability) },
        })
      }
    }
    if (this.#entries.has(id) && options.replace !== true) {
      throw new DecisionError('invalid_request', `Provider "${id}" is already registered.`, {
        subject: id,
        details: { hint: 'Pass replace: true to override a registered provider id.' },
      })
    }
    this.#entries.set(id, {
      provider,
      enabled: options.enabled ?? true,
      config: options.config ?? {},
    })
    if (this.#pendingDefaultId === id && (options.enabled ?? true)) {
      this.#defaultId = id
      this.#pendingDefaultId = undefined
    } else if (this.#defaultId === undefined && (options.enabled ?? true)) {
      this.#defaultId = id
    }
    return () => {
      if (this.#entries.get(id)?.provider === provider) this.unregister(id)
    }
  }

  /** Remove a provider by id. Returns whether anything was removed. */
  unregister(id: string): boolean {
    const removed = this.#entries.delete(id)
    if (removed && this.#defaultId === id) {
      this.#defaultId = this.#firstEnabledId()
      if (this.#pinnedDefaultId === id) this.#pendingDefaultId = id
    }
    return removed
  }

  /** Whether a provider id is registered (enabled or not). */
  has(id: string): boolean {
    return this.#entries.has(id)
  }

  /**
   * Look up a provider.
   *
   * @param id - provider id.
   * @returns the provider, or undefined.
   */
  get(id: string): DecisionProvider | undefined {
    return this.#entries.get(id)?.provider
  }

  /**
   * Look up a provider that must exist and be enabled.
   *
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  require(id: string): DecisionProvider {
    const entry = this.#entries.get(id)
    if (entry === undefined) {
      throw new DecisionError('provider_unknown', `No decision provider is registered as "${id}".`, {
        subject: id,
        details: { registered: [...this.#entries.keys()] },
      })
    }
    if (!entry.enabled) {
      throw new DecisionError('provider_unavailable', `Decision provider "${id}" is registered but disabled.`, {
        subject: id,
        details: { hint: `Enable it under providers.${id}.enabled.` },
      })
    }
    return entry.provider
  }

  /** Registration entry (provider, enabled flag, config) or undefined. */
  entry(id: string): ProviderRegistration | undefined {
    return this.#entries.get(id)
  }

  /** Ids of every registered provider, enabled or not, in registration order. */
  ids(): string[] {
    return [...this.#entries.keys()]
  }

  /** Ids of enabled providers, in registration order. */
  enabledIds(): string[] {
    return [...this.#entries.entries()].filter(([, entry]) => entry.enabled).map(([id]) => id)
  }

  /**
   * Ids of enabled providers that declare `capability`.
   *
   * @param capability - the required capability.
   * @returns matching provider ids in registration order.
   */
  idsWithCapability(capability: DecisionCapability): string[] {
    return [...this.#entries.entries()]
      .filter(([, entry]) => entry.enabled && entry.provider.capabilities.includes(capability))
      .map(([id]) => id)
  }

  /** Descriptors for every registered provider. */
  list(): ProviderDescriptor[] {
    return [...this.#entries.entries()].map(([id, entry]) => ({
      id,
      enabled: entry.enabled,
      capabilities: [...entry.provider.capabilities],
      hasHealthCheck: typeof entry.provider.healthCheck === 'function',
      isDefault: this.getDefaultId() === id,
    }))
  }

  /** The configured default provider id, or undefined when none is eligible. */
  getDefaultId(): string | undefined {
    return this.#pendingDefaultId === undefined ? this.#defaultId : undefined
  }

  /** A configured provider that has not yet been registered by its plugin. */
  getPendingDefaultId(): string | undefined {
    return this.#pendingDefaultId
  }

  /** Defer routing until an independently mounted provider registers this id. */
  deferDefault(id: string): void {
    if (id.trim() === '') throw new DecisionError('invalid_request', 'defaultProvider must be a non-empty string.')
    this.#pinnedDefaultId = id
    this.#pendingDefaultId = id
  }

  /** Use the first enabled provider without pinning a particular plugin id. */
  resetDefault(): void {
    this.#pinnedDefaultId = undefined
    this.#pendingDefaultId = undefined
    this.#defaultId = this.#firstEnabledId()
  }

  /**
   * Set the default provider id.
   *
   * @param id - a registered, enabled provider id.
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  setDefault(id: string): void {
    this.require(id)
    this.#defaultId = id
    this.#pinnedDefaultId = id
    this.#pendingDefaultId = undefined
  }

  /**
   * Resolve the provider for a request: the explicitly named one, else the
   * default.
   *
   * @param requestedId - provider the caller named, if any.
   * @returns the provider to use and its id.
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  resolve(requestedId?: string): { id: string; provider: DecisionProvider } {
    if (requestedId !== undefined) {
      if (typeof requestedId !== 'string' || requestedId.trim() === '') {
        throw new DecisionError('invalid_request', 'provider must be a non-empty string when present.')
      }
      return { id: requestedId, provider: this.require(requestedId) }
    }
    if (this.#pendingDefaultId !== undefined) {
      throw new DecisionError('provider_unknown', `Default decision provider "${this.#pendingDefaultId}" has not registered yet.`, {
        subject: this.#pendingDefaultId,
        details: { registered: [...this.#entries.keys()] },
      })
    }
    const defaultId = this.#defaultId
    if (defaultId === undefined) {
      throw new DecisionError('provider_unavailable', 'No decision provider is enabled.', {
        details: { registered: [...this.#entries.keys()], hint: 'Register a provider or enable one in config.' },
      })
    }
    return { id: defaultId, provider: this.require(defaultId) }
  }

  /**
   * Assert that a provider implements a mode before it is asked to run it.
   *
   * @throws DecisionError with `provider_unsupported_capability`.
   */
  assertCapability(id: string, mode: DecisionMode): void {
    const provider = this.require(id)
    if (!provider.capabilities.includes(mode)) {
      throw new DecisionError('provider_unsupported_capability', `Decision provider "${id}" does not implement "${mode}".`, {
        subject: id,
        details: { mode, capabilities: [...provider.capabilities] },
      })
    }
  }

  /**
   * Run every enabled provider's health check.
   *
   * A provider without a health check reports `ok` with no details. A health
   * check that throws is reported as `unavailable` rather than failing the
   * whole listing — one broken provider must not blind the caller to the rest.
   */
  async health(): Promise<Record<string, ProviderHealth>> {
    const result: Record<string, ProviderHealth> = {}
    for (const [id, entry] of this.#entries) {
      if (!entry.enabled) {
        result[id] = { status: 'unavailable', reason: 'disabled' }
        continue
      }
      const check = entry.provider.healthCheck
      if (typeof check !== 'function') {
        result[id] = { status: 'ok' }
        continue
      }
      try {
        result[id] = await check.call(entry.provider)
      } catch (error) {
        result[id] = {
          status: 'unavailable',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return result
  }

  /** Dispose every registered provider that owns resources. */
  async disposeAll(): Promise<void> {
    for (const [, entry] of this.#entries) {
      try {
        await entry.provider.dispose?.()
      } catch {
        // Disposal is best-effort: one provider failing must not keep the others alive.
      }
    }
    this.#entries.clear()
    this.#defaultId = undefined
    this.#pendingDefaultId = undefined
    this.#pinnedDefaultId = undefined
  }

  #firstEnabledId(): string | undefined {
    for (const [id, entry] of this.#entries) {
      if (entry.enabled) return id
    }
    return undefined
  }
}

/** The registry's own minimal provider-facing contract, re-exported for provider authors. */
export type { DecisionContext, DecisionProvider, DecisionRequest, DecisionResult, ProviderHealth }
