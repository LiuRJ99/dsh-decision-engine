/**
 * Environment registry: `id` → {@link EnvironmentAdapter}.
 *
 * Mirrors the provider registry's shape on the other side of the layer. The
 * runtime resolves an adapter by id; nothing in the runtime imports a concrete
 * adapter, so a new environment is `register(...)` and nothing else.
 *
 * @module dsh-decision-engine/environments/registry
 */

import { DecisionError } from '../core/errors.ts'
import type { EnvironmentAdapter } from './types.ts'

/** Snapshot of one registered environment, for listing and diagnostics. */
export interface EnvironmentDescriptor {
  id: string
  source: string
  capabilities: readonly string[]
  /** Whether the adapter can tell when the objective is met. */
  hasIsDone: boolean
}

/** Registry of environment adapters. */
export class EnvironmentRegistry {
  readonly #adapters = new Map<string, EnvironmentAdapter>()

  /**
   * Register an adapter.
   *
   * @param adapter - the adapter. Its `id` becomes the registry key.
   * @param options - `replace: true` overrides an existing id.
   * @returns the disposer that unregisters it.
   */
  register(adapter: EnvironmentAdapter, options: { replace?: boolean } = {}): () => void {
    const id = adapter?.id
    if (typeof id !== 'string' || id.trim() === '') {
      throw new DecisionError('invalid_request', 'An environment adapter must declare a non-empty string id.')
    }
    for (const method of ['observe', 'buildDecisionRequest', 'mapDecision', 'execute'] as const) {
      if (typeof adapter[method] !== 'function') {
        throw new DecisionError('invalid_request', `Environment adapter "${id}" must implement ${method}().`, { subject: id })
      }
    }
    if (this.#adapters.has(id) && options.replace !== true) {
      throw new DecisionError('invalid_request', `Environment adapter "${id}" is already registered.`, {
        subject: id,
        details: { hint: 'Pass replace: true to override a registered environment id.' },
      })
    }
    this.#adapters.set(id, adapter)
    return () => {
      this.#adapters.delete(id)
    }
  }

  /** Remove an adapter by id. Returns whether anything was removed. */
  unregister(id: string): boolean {
    return this.#adapters.delete(id)
  }

  /** Whether an id is registered. */
  has(id: string): boolean {
    return this.#adapters.has(id)
  }

  /** Look up an adapter, or undefined. */
  get(id: string): EnvironmentAdapter | undefined {
    return this.#adapters.get(id)
  }

  /**
   * Look up an adapter that must exist.
   *
   * @throws DecisionError with `environment_unknown`.
   */
  require(id: string): EnvironmentAdapter {
    const adapter = this.#adapters.get(id)
    if (adapter === undefined) {
      throw new DecisionError('environment_unknown', `No environment adapter is registered as "${id}".`, {
        subject: id,
        details: { registered: [...this.#adapters.keys()] },
      })
    }
    return adapter
  }

  /** Every registered environment id, in registration order. */
  ids(): string[] {
    return [...this.#adapters.keys()]
  }

  /** Descriptors for every registered adapter. */
  list(): EnvironmentDescriptor[] {
    return [...this.#adapters.entries()].map(([id, adapter]) => ({
      id,
      source: adapter.source,
      capabilities: [...(adapter.capabilities ?? [])],
      hasIsDone: typeof adapter.isDone === 'function',
    }))
  }

  /** Dispose every registered adapter that owns resources. */
  async disposeAll(): Promise<void> {
    for (const [, adapter] of this.#adapters) {
      try {
        await adapter.dispose?.()
      } catch {
        // Best-effort: one adapter failing to release must not keep the others alive.
      }
    }
    this.#adapters.clear()
  }
}
