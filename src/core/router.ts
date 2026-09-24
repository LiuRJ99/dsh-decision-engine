/**
 * Provider routing.
 *
 * Deliberately small for the first version: an explicit provider on the
 * request wins, otherwise the configured default runs. The seam that matters
 * is that routing is a separate, replaceable policy — a later version can
 * route on candidate count, task type, latency budget, or capability without
 * touching the engine, the environments, or any provider.
 *
 * @module dsh-decision-engine/core/router
 */

import { DecisionError } from './errors.ts'
import type { DecisionProviderRegistry } from './provider-registry.ts'
import type { DecisionMode, DecisionRequest } from './types.ts'

/** One routing decision, with the reason it was made. */
export interface RouteResult {
  providerId: string
  /** Why this provider was chosen: an explicit request field, the default, or a capability fallback. */
  reason: 'explicit' | 'default' | 'capability-fallback'
}

/**
 * Routing policy for decision calls.
 */
export class DecisionRouter {
  readonly #registry: DecisionProviderRegistry
  #allowCapabilityFallback: boolean

  /**
   * @param registry - provider membership.
   * @param options - routing config.
   */
  constructor(registry: DecisionProviderRegistry, options: { defaultProviderId?: string; allowCapabilityFallback?: boolean } = {}) {
    this.#registry = registry
    if (options.defaultProviderId !== undefined) this.#registry.setDefault(options.defaultProviderId)
    this.#allowCapabilityFallback = options.allowCapabilityFallback ?? true
  }

  /** The configured default provider id, if any. */
  get defaultProviderId(): string | undefined {
    return this.#registry.getDefaultId()
  }

  /** Whether a capability miss may fall back to another enabled provider. */
  get allowCapabilityFallback(): boolean {
    return this.#allowCapabilityFallback
  }

  /**
   * Re-point the default provider.
   *
   * @param id - a registered, enabled provider id, or undefined to fall back to
   *   the first enabled provider.
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  setDefaultProvider(id: string | undefined): void {
    if (id === undefined) this.#registry.resetDefault()
    else this.#registry.setDefault(id)
  }

  /** Allow or forbid capability fallback. */
  setAllowCapabilityFallback(allow: boolean): void {
    this.#allowCapabilityFallback = allow
  }

  /**
   * Choose a provider for a request.
   *
   * Order: an explicit `request.provider` field; then the configured default;
   * then — only when enabled and only if the chosen provider cannot run the
   * mode — the first enabled provider that declares the capability.
   *
   * @param request - the decision request.
   * @param mode - the resolved mode.
   * @returns the chosen provider id and why.
   * @throws DecisionError with `provider_unknown`, `provider_unavailable`, or
   *   `provider_unsupported_capability`.
   */
  route(request: DecisionRequest, mode: DecisionMode): RouteResult {
    const explicit = request.provider
    if (explicit !== undefined) {
      const providerId = explicit
      this.#registry.require(providerId)
      this.#registry.assertCapability(providerId, mode)
      return { providerId, reason: 'explicit' }
    }

    const pending = this.#registry.getPendingDefaultId()
    if (pending !== undefined) {
      throw new DecisionError('provider_unknown', `Default decision provider "${pending}" has not registered yet.`, {
        subject: pending,
        details: { registered: this.#registry.ids() },
      })
    }

    const preferred = this.#registry.getDefaultId()
    if (preferred !== undefined) {
      const provider = this.#registry.require(preferred)
      if (provider.capabilities.includes(mode)) return { providerId: preferred, reason: 'default' }
      if (!this.#allowCapabilityFallback) {
        throw new DecisionError('provider_unsupported_capability', `Default provider "${preferred}" does not implement "${mode}".`, {
          subject: preferred,
          details: { mode, capabilities: [...provider.capabilities] },
        })
      }
      const fallback = this.#registry.idsWithCapability(mode).find(id => id !== preferred)
      if (fallback !== undefined) return { providerId: fallback, reason: 'capability-fallback' }
      throw new DecisionError('provider_unsupported_capability', `No enabled provider implements "${mode}".`, {
        subject: preferred,
        details: { mode, enabled: this.#registry.enabledIds() },
      })
    }

    const capable = this.#registry.idsWithCapability(mode)
    const first = capable[0]
    if (first === undefined) {
      const enabled = this.#registry.enabledIds()
      const detail = { mode, enabled }
      // "Nothing is enabled" and "everything enabled lacks this mode" are
      // different problems with different fixes, so they get different codes.
      throw enabled.length === 0
        ? new DecisionError('provider_unavailable', 'No decision provider is enabled.', { details: detail })
        : new DecisionError('provider_unsupported_capability', `No enabled provider implements "${mode}".`, { details: detail })
    }
    return { providerId: first, reason: 'capability-fallback' }
  }
}
