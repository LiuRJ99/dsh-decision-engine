/**
 * A composite provider whose fallback is gated on **order invariance**.
 *
 * ## The problem it solves
 *
 * A small decision model can answer by *position* instead of by *content*: ask it
 * the same question twice with the candidates listed in a different order and it
 * picks whatever sits in the same slot both times. Every downstream reading of
 * such an answer is wrong — including "which candidate won", and including any
 * confidence gate built on the model's own score, because that score is itself
 * ordered by position.
 *
 * This was measured, not assumed. Same game state, same four candidates, only the
 * order reversed: the winner flipped from `chase` to `straight`, every score stayed
 * sorted by slot, and the top-1 number moved from 0.551 to 0.295 — across a 0.3
 * floor, i.e. an absolute-threshold gate would have changed its verdict purely
 * because the list was reordered.
 *
 * ## The gate
 *
 * Ask the primary arm twice, the second time with the candidate list **rotated**.
 * Rotation moves *every* element, so any position-determined policy (first slot,
 * last slot, middle, …) necessarily answers differently the second time, while a
 * provider that reads the candidates answers the same id both times.
 *
 * - arms agree on the id → the answer is order-invariant → return it, naming the primary;
 * - arms disagree → the primary is not reading the candidates → answer from the fallback,
 *   naming the fallback.
 *
 * The gate needs no domain knowledge: it looks only at candidate ids, never at what
 * they mean, which is why it is a provider-layer concern and not an environment hack.
 *
 * ## Spec conformance
 *
 * - `capabilities` is the **intersection** of both arms: a request outside it could be
 *   refused by one of the arms mid-flight, so claiming more would be a lie.
 * - `confidence` / `confidenceKind` are passed through verbatim from whichever arm
 *   answered. The gate never synthesizes a number, and never relabels a raw scale as
 *   `normalized` — see `docs/外部接入规范.md` §1.3.
 * - The answering arm is named in `DecisionResult.provider` (§3.1b), which is the
 *   protocol's channel for exactly this: a caller can see whether the model answered
 *   or the fallback did.
 * - The extra probe is the only cost: two primary calls per decision instead of one.
 *
 * @module dsh-decision-engine/providers/consistency-gate
 */

import { DecisionError } from '../core/errors.ts'
import type {
  DecisionCapability,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  ProviderHealth,
} from '../core/types.ts'

/** Canonical capability order, so the intersection has a stable shape. */
const CAPABILITY_ORDER: readonly DecisionCapability[] = ['choice', 'ranking', 'score', 'classification']

/** Gate bookkeeping, for tests and telemetry. */
export interface ConsistencyGateStats {
  /** Decisions where a second probe was actually run. */
  probes: number
  /** Second probe returned the same candidate id (order-invariant). */
  agreements: number
  /** Second probe returned a different candidate id (position-determined). */
  disagreements: number
  /** Times the fallback arm supplied the answer. */
  fallbacks: number
  /** Times the primary arm threw and the fallback was used to recover. */
  primaryFailures: number
  /** Times the primary threw and the fallback threw too. */
  bothFailed: number
}

/** Options for {@link ConsistencyGatedProvider}. */
export interface ConsistencyGateOptions {
  /** Registered id. Defaults to `<primary>-consistency-gated`; must be lowercase-kebab. */
  id?: string
  /** The arm asked first. */
  primary: DecisionProvider
  /** The arm asked when the gate rejects the primary's answer, or the primary throws. */
  fallback: DecisionProvider
  /**
   * How far the second probe rotates the candidate list. Defaults to 1.
   *
   * The effective rotation is always non-zero modulo the candidate count, so a
   * rotation that would accidentally reproduce the original order is bumped to 1 —
   * otherwise the gate would compare an order against itself and always "agree".
   */
  rotation?: number
}

/**
 * Composite provider: the primary arm answers unless its answer changes when the
 * candidates are reordered, in which case the fallback arm answers instead.
 */
export class ConsistencyGatedProvider implements DecisionProvider {
  readonly id: string
  readonly capabilities: readonly DecisionCapability[]

  readonly #primary: DecisionProvider
  readonly #fallback: DecisionProvider
  readonly #rotation: number
  readonly #stats: ConsistencyGateStats = {
    probes: 0,
    agreements: 0,
    disagreements: 0,
    fallbacks: 0,
    primaryFailures: 0,
    bothFailed: 0,
  }

  constructor(options: ConsistencyGateOptions) {
    const { primary, fallback } = options
    if (primary === undefined || fallback === undefined) {
      throw new DecisionError('invalid_request', 'A consistency gate needs both a primary and a fallback arm.', { subject: 'consistency-gate' })
    }
    if (primary === fallback) {
      throw new DecisionError('invalid_request', 'The primary and fallback arms must be different providers.', { subject: 'consistency-gate' })
    }
    this.id = options.id ?? `${primary.id}-consistency-gated`
    this.#primary = primary
    this.#fallback = fallback
    this.#rotation = options.rotation ?? 1
    // Only claim what both arms can do: whichever arm ends up answering must be
    // able to serve the request.
    this.capabilities = CAPABILITY_ORDER.filter(
      (capability) => primary.capabilities.includes(capability) && fallback.capabilities.includes(capability),
    )
  }

  async decide(request: DecisionRequest, context?: Parameters<DecisionProvider['decide']>[1]): Promise<DecisionResult> {
    const startedAt = Date.now()
    const arm = (result: DecisionResult, providerId: string, notes: string | undefined): DecisionResult => {
      const out: DecisionResult = { ...result, provider: providerId, latencyMs: Date.now() - startedAt }
      if (notes !== undefined && context?.debug === true) {
        out.debug = { ...result.debug, notes: [...(result.debug?.notes ?? []), notes] }
      }
      return out
    }

    // ---- first probe ----
    let first: DecisionResult
    try {
      first = await this.#primary.decide(request, context)
    } catch (error) {
      this.#stats.primaryFailures += 1
      return await this.#recover(error, request, context, arm)
    }

    // Nothing to check: no selection, or an ordering that cannot be permuted.
    if (first.selected === undefined || request.candidates.length < 2) {
      return arm(first, this.#primary.id, 'gate: not applicable (no selection to re-check)')
    }

    // ---- second probe, with the candidate list rotated ----
    const rotated = rotate(request.candidates, this.#rotation)
    const second = await this.#primary.decide({ ...request, candidates: rotated }, context)
    this.#stats.probes += 1

    if (second.selected === first.selected) {
      this.#stats.agreements += 1
      return arm(first, this.#primary.id, `gate: order-invariant (same id under rotation ${this.#effectiveRotation(request.candidates.length)})`)
    }

    // ---- the primary answered by position, not by content ----
    this.#stats.disagreements += 1
    const note =
      `gate: rejected "${this.#primary.id}" — it answered "${first.selected}" in the given order and ` +
      `"${second.selected}" after rotating the candidates by ${this.#effectiveRotation(request.candidates.length)}; ` +
      'the answer tracks position, not the candidates.'
    try {
      const recovered = await this.#fallback.decide(request, context)
      this.#stats.fallbacks += 1
      return arm(recovered, this.#fallback.id, note)
    } catch (error) {
      this.#stats.bothFailed += 1
      throw new DecisionError(
        'provider_failed',
        `${note} The fallback arm "${this.#fallback.id}" also failed: ${messageOf(error)}`,
        { subject: this.id, details: { primary: this.#primary.id, fallback: this.#fallback.id, primarySelected: first.selected, primarySelectedRotated: second.selected } },
      )
    }
  }

  /** The primary threw: try the fallback, and only surface a failure if it fails too. */
  async #recover(
    error: unknown,
    request: DecisionRequest,
    context: Parameters<DecisionProvider['decide']>[1],
    arm: (result: DecisionResult, providerId: string, notes: string | undefined) => DecisionResult,
  ): Promise<DecisionResult> {
    const note = `gate: "${this.#primary.id}" failed (${messageOf(error)}); answered by the fallback arm.`
    try {
      const recovered = await this.#fallback.decide(request, context)
      this.#stats.fallbacks += 1
      return arm(recovered, this.#fallback.id, note)
    } catch (fallbackError) {
      this.#stats.bothFailed += 1
      throw new DecisionError(
        'provider_failed',
        `Both arms failed. "${this.#primary.id}": ${messageOf(error)}. "${this.#fallback.id}": ${messageOf(fallbackError)}`,
        { subject: this.id, details: { primary: this.#primary.id, fallback: this.#fallback.id } },
      )
    }
  }

  /** Snapshot of the gate's bookkeeping. */
  stats(): Readonly<ConsistencyGateStats> {
    return { ...this.#stats }
  }

  /**
   * `unavailable` when an arm cannot serve at all, `degraded` when only the fallback
   * is usable — in that case every decision is answered by a non-primary arm, which
   * callers should see rather than discover.
   */
  async healthCheck(): Promise<ProviderHealth> {
    const [primary, fallback] = await Promise.all([
      checkArm(this.#primary),
      checkArm(this.#fallback),
    ])
    const details: Record<string, unknown> = { primary, fallback, stats: this.stats() }
    if (primary.status === 'unavailable' && fallback.status === 'unavailable') {
      return { status: 'unavailable', reason: 'Both arms are unavailable.', details }
    }
    if (primary.status !== 'ok') {
      const why = primary.reason === undefined ? '' : ` (${primary.reason})`
      return { status: 'degraded', reason: `Primary arm "${this.#primary.id}" is ${primary.status}${why}; decisions fall back to "${this.#fallback.id}".`, details }
    }
    if (fallback.status !== 'ok') {
      const why = fallback.reason === undefined ? '' : ` (${fallback.reason})`
      return { status: 'degraded', reason: `Fallback arm "${this.#fallback.id}" is ${fallback.status}${why}; a rejected answer cannot be recovered.`, details }
    }
    return { status: 'ok', details }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([
      Promise.resolve(this.#primary.dispose?.()),
      Promise.resolve(this.#fallback.dispose?.()),
    ])
  }

  /** Non-zero rotation, modulo the candidate count. */
  #effectiveRotation(count: number): number {
    const normalized = ((Math.trunc(this.#rotation) % count) + count) % count
    return normalized === 0 ? 1 : normalized
  }
}

/** Rotate the candidate list left by `by`, leaving the original untouched. */
function rotate<T>(items: readonly T[], by: number): T[] {
  const n = items.length
  if (n < 2) return [...items]
  const normalized = ((Math.trunc(by) % n) + n) % n
  const k = normalized === 0 ? 1 : normalized
  return [...items.slice(k), ...items.slice(0, k)]
}

async function checkArm(provider: DecisionProvider): Promise<ProviderHealth> {
  if (provider.healthCheck === undefined) return { status: 'ok' }
  try {
    return await provider.healthCheck()
  } catch (error) {
    return { status: 'unavailable', reason: `healthCheck threw: ${messageOf(error)}` }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
