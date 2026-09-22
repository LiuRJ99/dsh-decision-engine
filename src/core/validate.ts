/**
 * Request validation and result normalization — the guard rails that keep an
 * untrusted or buggy provider from leaking into the environment layer.
 *
 * Two rules justify this module's existence:
 *
 * 1. A decision may only ever name an id the caller supplied. A provider that
 *    invents an action fails the call rather than reaching an action mapper.
 * 2. A result the protocol cannot express is a failure, not something to
 *    repair silently.
 *
 * @module dsh-decision-engine/core/validate
 */

import { DecisionError } from './errors.ts'
import {
  createDecisionResult,
  isDecisionCapability,
  isDecisionConfidenceKind,
  type DecisionCandidate,
  type DecisionConfidenceKind,
  type DecisionMode,
  type DecisionRankEntry,
  type DecisionRequest,
  type DecisionResult,
  type DecisionUsage,
} from './types.ts'

/** A request that passed validation, with the mode and candidate index resolved. */
export interface ValidatedRequest {
  request: DecisionRequest
  /** Mode to run: the request's, or `choice` when omitted. */
  mode: DecisionMode
  /** Candidate id → candidate, for O(1) membership checks. */
  byId: Map<string, DecisionCandidate>
}

/** Longest candidate list accepted in one request. Keeps the finite-candidate promise real. */
export const MAX_CANDIDATES = 64

/** Longest state payload accepted, in characters, so one call cannot flood a model context. */
export const MAX_STATE_CHARS = 200_000

/** Longest objective accepted, in characters. */
export const MAX_OBJECTIVE_CHARS = 8_000

/**
 * Validate a caller-supplied request.
 *
 * @param request - the raw request.
 * @returns the validated request plus resolved mode and candidate index.
 * @throws DecisionError with `invalid_request` or `no_candidates`.
 */
export function validateRequest(request: DecisionRequest): ValidatedRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new DecisionError('invalid_request', 'A decision request must be an object.')
  }
  const state = request.state
  if (typeof state !== 'string' && (typeof state !== 'object' || state === null || Array.isArray(state))) {
    throw new DecisionError('invalid_request', 'A decision request must carry state as a string or an object.')
  }
  if (typeof state === 'string' && state.length > MAX_STATE_CHARS) {
    throw new DecisionError('invalid_request', `State exceeds the ${MAX_STATE_CHARS}-character limit.`, {
      details: { length: state.length, limit: MAX_STATE_CHARS },
    })
  }
  if (request.objective !== undefined && typeof request.objective !== 'string') {
    throw new DecisionError('invalid_request', 'objective must be a string when present.')
  }
  if (typeof request.objective === 'string' && request.objective.length > MAX_OBJECTIVE_CHARS) {
    throw new DecisionError('invalid_request', `Objective exceeds the ${MAX_OBJECTIVE_CHARS}-character limit.`, {
      details: { length: request.objective.length, limit: MAX_OBJECTIVE_CHARS },
    })
  }
  if (request.mode !== undefined && !isDecisionCapability(request.mode)) {
    throw new DecisionError('invalid_request', `Unknown decision mode "${String(request.mode)}".`, {
      details: { supported: ['choice', 'ranking', 'score', 'classification'] },
    })
  }
  if (request.constraints !== undefined && (!Array.isArray(request.constraints) || request.constraints.some(item => typeof item !== 'string'))) {
    throw new DecisionError('invalid_request', 'constraints must be an array of strings when present.')
  }
  if (!Array.isArray(request.candidates)) {
    throw new DecisionError('invalid_request', 'A decision request must carry a candidates array.')
  }
  if (request.candidates.length === 0) {
    throw new DecisionError('no_candidates', 'A decision request must carry at least one candidate.', {
      details: { hint: 'Supply the finite option set the decider may choose from.' },
    })
  }
  if (request.candidates.length > MAX_CANDIDATES) {
    throw new DecisionError('invalid_request', `Candidate count exceeds the ${MAX_CANDIDATES}-candidate limit.`, {
      details: { count: request.candidates.length, limit: MAX_CANDIDATES },
    })
  }
  const byId = new Map<string, DecisionCandidate>()
  for (let index = 0; index < request.candidates.length; index += 1) {
    const candidate = request.candidates[index]
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new DecisionError('invalid_request', `candidates[${index}] must be an object.`)
    }
    if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
      throw new DecisionError('invalid_request', `candidates[${index}].id must be a non-empty string.`)
    }
    if (typeof candidate.description !== 'string' || candidate.description.trim() === '') {
      throw new DecisionError('invalid_request', `candidates[${index}].description must be a non-empty string.`)
    }
    if (byId.has(candidate.id)) {
      throw new DecisionError('invalid_request', `Duplicate candidate id "${candidate.id}".`, { details: { id: candidate.id } })
    }
    byId.set(candidate.id, candidate)
  }
  const mode: DecisionMode = request.mode ?? 'choice'
  return { request, mode, byId }
}

/**
 * Read a provider's confidence pair.
 *
 * The rule this enforces is the whole point of {@link DecisionConfidenceKind}:
 * **a number and its kind travel together**. A provider that returns a bare
 * number with no kind is rejected rather than guessed at, because the engine
 * cannot know whether that number may be compared with its threshold. A
 * provider that has no comparable confidence says `unavailable` and returns no
 * number.
 *
 * @returns the validated pair, or a failure reason.
 */
function readConfidence(
  value: unknown,
  kind: unknown,
  providerId: string,
): { ok: true; confidence?: number; confidenceKind?: DecisionConfidenceKind } | { ok: false; message: string } {
  const hasNumber = value !== undefined && value !== null
  const hasKind = kind !== undefined && kind !== null

  if (hasNumber && typeof value !== 'number') {
    return { ok: false, message: `Provider "${providerId}" returned a non-numeric confidence.` }
  }
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  if (hasNumber && numeric === undefined) {
    return { ok: false, message: `Provider "${providerId}" returned a non-finite confidence.` }
  }
  if (hasKind && !isDecisionConfidenceKind(kind)) {
    return { ok: false, message: `Provider "${providerId}" returned unknown confidenceKind ${JSON.stringify(kind)}.` }
  }
  const confidenceKind = isDecisionConfidenceKind(kind) ? kind : undefined

  if (numeric !== undefined && (numeric < 0 || numeric > 1)) {
    return { ok: false, message: `Provider "${providerId}" returned confidence ${numeric}, outside 0..1.` }
  }
  if (numeric !== undefined && confidenceKind === undefined) {
    return {
      ok: false,
      message: `Provider "${providerId}" returned a confidence without a confidenceKind, so the engine cannot tell `
        + 'whether it is comparable with the configured threshold.',
    }
  }
  if (numeric !== undefined && confidenceKind === 'unavailable') {
    return { ok: false, message: `Provider "${providerId}" returned confidenceKind "unavailable" together with a number.` }
  }
  if (numeric === undefined && confidenceKind !== undefined && confidenceKind !== 'unavailable') {
    return {
      ok: false,
      message: `Provider "${providerId}" declared confidenceKind "${confidenceKind}" but returned no confidence number.`,
    }
  }
  return {
    ok: true,
    ...numeric === undefined ? {} : { confidence: numeric },
    ...confidenceKind === undefined ? {} : { confidenceKind },
  }
}

/**
 * Keep only the usage counters a caller can act on: finite, non-negative
 * numbers. A provider reporting a nonsense count must not fail an otherwise good
 * decision — usage is accounting, not protocol conformance.
 */
function sanitizeUsage(value: unknown): DecisionUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const usage: DecisionUsage = {}
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    const raw = record[key]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) usage[key] = raw
  }
  const metrics = record.metrics
  if (typeof metrics === 'object' && metrics !== null && !Array.isArray(metrics)) {
    const kept: Record<string, number> = {}
    for (const [name, raw] of Object.entries(metrics as Record<string, unknown>)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) kept[name] = raw
    }
    if (Object.keys(kept).length > 0) usage.metrics = kept
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

/** Sort comparator: highest score first, ties broken by original order (stable). */
function byScoreDescending(left: { index: number; score: number | undefined }, right: { index: number; score: number | undefined }): number {
  const leftScore = left.score ?? Number.NEGATIVE_INFINITY
  const rightScore = right.score ?? Number.NEGATIVE_INFINITY
  if (rightScore !== leftScore) return rightScore - leftScore
  return left.index - right.index
}

/**
 * Normalize a provider's raw answer into a protocol {@link DecisionResult}.
 *
 * The provider may return a partial result — typically only `selected` or only
 * `ranking`. This function:
 * - rejects a `selected` id outside the candidate set (`unknown_candidate`),
 * - drops ranking entries outside it rather than failing the whole call,
 * - derives `selected` from the ranking when the provider omitted it,
 * - derives `ranking` from `selected` when the ranking is empty,
 * - keeps `confidence` only when it is a finite 0..1 number.
 *
 * @param raw - the provider's answer, before protocol enforcement.
 * @param options - validated request facts the provider answered.
 * @returns the normalized result.
 * @throws DecisionError with `invalid_decision` or `unknown_candidate`.
 */
export function normalizeDecisionResult(
  raw: unknown,
  options: {
    providerId: string
    mode: DecisionMode
    validated: ValidatedRequest
    latencyMs: number
    /** Whether the caller asked for provider-private debug detail. */
    includeDebug?: boolean
  },
): DecisionResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DecisionError('invalid_decision', `Provider "${options.providerId}" returned a non-object decision.`, {
      subject: options.providerId,
      details: { received: typeof raw },
    })
  }
  const value = raw as Partial<DecisionResult> & { provider?: unknown; mode?: unknown }

  const { byId } = options.validated
  const selected = value.selected
  if (selected !== undefined && typeof selected !== 'string') {
    throw new DecisionError('invalid_decision', `Provider "${options.providerId}" returned a non-string selected id.`, {
      subject: options.providerId,
      details: { received: typeof selected },
    })
  }
  if (selected !== undefined && !byId.has(selected)) {
    throw new DecisionError('unknown_candidate', `Provider "${options.providerId}" selected "${selected}", which is not in the candidate set.`, {
      subject: options.providerId,
      details: { selected, candidates: [...byId.keys()] },
    })
  }

  const ranking: DecisionRankEntry[] = []
  const seen = new Set<string>()
  if (value.ranking !== undefined) {
    if (!Array.isArray(value.ranking)) {
      throw new DecisionError('invalid_decision', `Provider "${options.providerId}" returned a non-array ranking.`, {
        subject: options.providerId,
        details: { received: typeof value.ranking },
      })
    }
    for (let index = 0; index < value.ranking.length; index += 1) {
      const entry = value.ranking[index]
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const id = (entry as { id?: unknown }).id
      if (typeof id !== 'string' || !byId.has(id) || seen.has(id)) continue
      seen.add(id)
      const score = (entry as { score?: unknown }).score
      ranking.push(
        typeof score === 'number' && Number.isFinite(score)
          ? { id, score }
          : { id },
      )
    }
  }

  let resolvedSelected = selected
  if (resolvedSelected === undefined && ranking.length > 0) resolvedSelected = ranking[0]?.id
  if (ranking.length === 0) {
    if (resolvedSelected === undefined) {
      throw new DecisionError('invalid_decision', `Provider "${options.providerId}" returned neither a selection nor a ranking.`, {
        subject: options.providerId,
      })
    }
    ranking.push({ id: resolvedSelected })
  }
  if (resolvedSelected === undefined) {
    throw new DecisionError('invalid_decision', `Provider "${options.providerId}" produced no usable selection.`, {
      subject: options.providerId,
    })
  }

  const confidence = readConfidence(value.confidence, value.confidenceKind, options.providerId)
  if (!confidence.ok) {
    throw new DecisionError('invalid_decision', confidence.message, { subject: options.providerId })
  }
  const debug: DecisionResult['debug'] | undefined = options.includeDebug === true ? value.debug : undefined

  // A provider may name the arm that answered; otherwise the registered id is
  // the answer. Routing already happened, so this is descriptive.
  const reportedProvider = typeof value.provider === 'string' && value.provider.trim() !== ''
    ? value.provider
    : options.providerId
  return createDecisionResult({
    provider: reportedProvider,
    mode: options.mode,
    selected: resolvedSelected,
    ranking,
    latencyMs: options.latencyMs,
    ...sanitizeUsage(value.usage) === undefined ? {} : { usage: sanitizeUsage(value.usage) },
    ...confidence.confidence === undefined ? {} : { confidence: confidence.confidence },
    ...confidence.confidenceKind === undefined ? {} : { confidenceKind: confidence.confidenceKind },
    ...debug === undefined ? {} : { debug: debug as DecisionResult['debug'] },
  })
}

/**
 * Sort candidate ids by descending score. Used by providers that score every
 * candidate and by the `score`/`ranking` modes.
 *
 * @param entries - id/score pairs, scores optional.
 * @returns a new array, best first, ties in the input's order.
 */
export function rankByScore(entries: readonly { id: string; score?: number }[]): DecisionRankEntry[] {
  return entries
    .map((entry, index) => ({ id: entry.id, score: entry.score, index }))
    .sort(byScoreDescending)
    .map(entry => (entry.score === undefined ? { id: entry.id } : { id: entry.id, score: entry.score }))
}
