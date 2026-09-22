/**
 * The Decision Engine: one entry point, `decide(request)`.
 *
 * The engine owns exactly four things and nothing else:
 *
 * 1. request validation (the finite-candidate contract),
 * 2. provider selection through the router,
 * 3. capability assertion and deadline enforcement around the provider call,
 * 4. result normalization and confidence gating.
 *
 * It has no knowledge of any environment, tool, or model. Environments are
 * driven by the runtime on top of the engine; providers plug in through the
 * registry.
 *
 * @module dsh-decision-engine/core/decision-engine
 */

import { DecisionError, toDecisionFailure } from './errors.ts'
import { DecisionProviderRegistry } from './provider-registry.ts'
import { DecisionRouter } from './router.ts'
import type { DecisionTelemetry, DecisionTelemetrySink } from './telemetry.ts'
import { normalizeDecisionResult, validateRequest } from './validate.ts'
import type { DecisionContext, DecisionRequest, DecisionResult, ProviderHealth } from './types.ts'

/** Engine configuration. */
export interface DecisionEngineConfig {
  /** Provider id used when a request does not name one. */
  defaultProviderId?: string
  /**
   * Confidence floor for a `choice`/`classification` decision. A result below
   * it fails with `low_confidence` so the caller escalates instead of acting
   * on a guess. Set to 0 to accept anything.
   */
  confidenceThreshold?: number
  /** Per-call provider budget in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /** Whether the router may fall back to another provider on a capability miss. Defaults to true. */
  allowCapabilityFallback?: boolean
  /** Telemetry consumer. Failures inside it never affect a decision. */
  telemetry?: DecisionTelemetrySink
  /**
   * Injectable clock, for tests. Returns milliseconds, and should be
   * sub-millisecond precise: the layer's own overhead is well under 1 ms, so an
   * integer-millisecond clock cannot measure it. Defaults to `performance.now()`.
   */
  now?: () => number
}

/**
 * Monotonic millisecond clock. `performance.now()` is used rather than
 * `Date.now()` because the engine measures its own overhead, which is
 * fractional milliseconds.
 */
function defaultClock(): number {
  return performance.now()
}

/** Options for one {@link DecisionEngine.decide} call. */
export interface EngineDecideOptions {
  /** Explicit provider for this call; overrides the request's own `provider` field. */
  provider?: string
  /** Cancellation forwarded to the provider. */
  signal?: AbortSignal
  /** Per-call budget override, in milliseconds. */
  timeoutMs?: number
  /** Ask the provider for private debug detail and keep it on the result. */
  debug?: boolean
  /** Environment id recorded in telemetry and forwarded to the provider. */
  environment?: string
  /**
   * Runtime step index, when this decision is one step of a run. Present means
   * the runtime is driving, and the emitted record carries the step's
   * per-layer timings — one record per step, not two.
   */
  step?: number
  /**
   * Per-layer timings the caller already measured (observation, mapping,
   * execution). Merged into the emitted record so a slow environment is never
   * reported as a slow model.
   */
  sourceTimings?: { observeMs?: number; mapMs?: number; executeMs?: number }
  /**
   * Override the confidence floor for this call. `0` accepts any confidence;
   * `undefined` uses the engine's configured floor.
   */
  confidenceThreshold?: number
}

/**
 * The engine.
 *
 * Instances are safe to share: `decide` holds no cross-call state.
 */
export class DecisionEngine {
  readonly #registry: DecisionProviderRegistry
  readonly #router: DecisionRouter
  readonly #config: Required<Pick<DecisionEngineConfig, 'confidenceThreshold' | 'timeoutMs' | 'allowCapabilityFallback'>>
  readonly #telemetry: DecisionTelemetrySink | undefined
  readonly #now: () => number

  constructor(config: DecisionEngineConfig = {}, registry: DecisionProviderRegistry = new DecisionProviderRegistry()) {
    this.#registry = registry
    this.#router = new DecisionRouter(registry, {
      ...config.defaultProviderId === undefined ? {} : { defaultProviderId: config.defaultProviderId },
      ...config.allowCapabilityFallback === undefined ? {} : { allowCapabilityFallback: config.allowCapabilityFallback },
    })
    this.#config = {
      confidenceThreshold: config.confidenceThreshold ?? 0.55,
      timeoutMs: config.timeoutMs ?? 30_000,
      allowCapabilityFallback: config.allowCapabilityFallback ?? true,
    }
    this.#telemetry = config.telemetry
    this.#now = config.now ?? defaultClock
  }

  /** The provider registry, so a composition root can register providers. */
  get registry(): DecisionProviderRegistry {
    return this.#registry
  }

  /** The routing policy, exposed read-only for diagnostics. */
  get router(): DecisionRouter {
    return this.#router
  }

  /** The configured confidence floor. */
  get confidenceThreshold(): number {
    return this.#config.confidenceThreshold
  }

  /**
   * Answer one decision request.
   *
   * @param request - objective, state, finite candidates, optional mode/provider.
   * @param options - transport concerns: cancellation, budget, debug, environment.
   * @returns the normalized decision result.
   * @throws DecisionError for every refusal; never a bare Error.
   */
  async decide(request: DecisionRequest, options: EngineDecideOptions = {}): Promise<DecisionResult> {
    const started = this.#now()
    let candidateCount: number | undefined
    let providerId: string | undefined
    let mode: DecisionRequest['mode']
    try {
      const validated = validateRequest(request)
      mode = validated.mode
      candidateCount = validated.request.candidates.length

      const explicitProvider = options.provider ?? request.provider
      const route = this.#router.route(
        explicitProvider === undefined ? request : { ...request, provider: explicitProvider },
        validated.mode,
      )
      providerId = route.providerId
      const provider = this.#registry.require(providerId)
      this.#registry.assertCapability(providerId, validated.mode)

      const budgetMs = options.timeoutMs ?? this.#config.timeoutMs
      const callStarted = this.#now()
      const raw = await this.#callProvider(provider, request, validated.mode, budgetMs, options)
      const latencyMs = this.#now() - callStarted

      const result = normalizeDecisionResult(raw, {
        providerId,
        mode: validated.mode,
        validated,
        latencyMs,
        includeDebug: options.debug === true,
      })

      const threshold = options.confidenceThreshold ?? this.#config.confidenceThreshold
      if (
        threshold > 0
        && result.confidence !== undefined
        && result.confidence < threshold
        && (validated.mode === 'choice' || validated.mode === 'classification')
      ) {
        throw new DecisionError('low_confidence', `Provider "${providerId}" returned confidence ${result.confidence.toFixed(3)}, below the ${threshold} floor.`, {
          subject: providerId,
          details: { confidence: result.confidence, threshold, selected: result.selected },
        })
      }

      this.#emit({
        kind: options.step === undefined ? 'decision' : 'step',
        provider: providerId,
        mode: validated.mode,
        candidateCount,
        ...result.selected === undefined ? {} : { selected: result.selected },
        ...result.confidence === undefined ? {} : { confidence: result.confidence },
        ...options.environment === undefined ? {} : { environment: options.environment },
        ...options.step === undefined ? {} : { step: options.step },
        timings: {
          ...options.sourceTimings ?? {},
          decisionMs: result.latencyMs,
          totalMs: this.#now() - started,
        },
      })
      return result
    } catch (error) {
      const failure = toDecisionFailure(error)
      this.#emit({
        kind: options.step === undefined ? 'decision' : 'step',
        ...providerId === undefined ? {} : { provider: providerId },
        ...mode === undefined ? {} : { mode },
        ...candidateCount === undefined ? {} : { candidateCount },
        ...options.environment === undefined ? {} : { environment: options.environment },
        ...options.step === undefined ? {} : { step: options.step },
        escalationReason: failure.code,
        timings: { ...options.sourceTimings ?? {}, totalMs: this.#now() - started },
      })
      throw error instanceof DecisionError ? error : new DecisionError(failure.code, failure.message, {
        ...failure.details === undefined ? {} : { details: failure.details },
        cause: error,
      })
    }
  }

  /** Health of every registered provider. */
  async health(): Promise<Record<string, ProviderHealth>> {
    return this.#registry.health()
  }

  /** Dispose every provider and clear the registry. */
  async dispose(): Promise<void> {
    await this.#registry.disposeAll()
  }

  /**
   * Invoke one provider under a deadline.
   *
   * The deadline is enforced by racing the provider's promise, not by trusting
   * the provider to honor the signal: a model runtime that ignores abort would
   * otherwise hold the step forever. The signal is still passed through so a
   * cooperative provider can stop its own work.
   */
  async #callProvider(
    provider: { id?: string; decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult> },
    request: DecisionRequest,
    _mode: DecisionRequest['mode'],
    budgetMs: number,
    options: EngineDecideOptions,
  ): Promise<DecisionResult> {
    const providerLabel = provider.id ?? 'unknown'
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(options.signal?.reason)
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort(options.signal.reason)
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('decision timeout'))
        reject(new DecisionError('provider_timeout', `Decision provider "${providerLabel}" exceeded its ${budgetMs}ms budget.`, {
          subject: providerLabel,
          details: { timeoutMs: budgetMs },
        }))
      }, budgetMs)
      if (typeof timer.unref === 'function') timer.unref()
    })

    const context: DecisionContext = {
      signal: controller.signal,
      timeoutMs: budgetMs,
      ...options.debug === undefined ? {} : { debug: options.debug },
      ...options.environment === undefined ? {} : { environment: options.environment },
    }

    try {
      const decision = Promise.resolve(provider.decide(request, context)).catch((error: unknown) => {
        if (controller.signal.aborted && !(error instanceof DecisionError)) {
          throw new DecisionError('aborted', 'The decision provider was aborted before it settled.', { cause: error })
        }
        throw error
      })
      return await Promise.race([decision, timeoutPromise])
    } catch (error) {
      if (error instanceof DecisionError) throw error
      const failure = toDecisionFailure(error, 'provider_failed')
      throw new DecisionError(failure.code, failure.message, {
        ...failure.details === undefined ? {} : { details: failure.details },
        cause: error,
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
    }
  }

  #emit(record: DecisionTelemetry): void {
    if (this.#telemetry === undefined) return
    try {
      this.#telemetry(record)
    } catch {
      // A telemetry sink must never break a decision.
    }
  }
}
