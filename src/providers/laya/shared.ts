/**
 * Shared helpers for the Laya provider's mode translators: bounded state
 * serialization, candidate rendering, and answer inspection.
 *
 * Kept in one place so every mode sees exactly the same state text — a
 * difference between modes would mean the model is being asked different
 * questions about different worlds.
 *
 * @module dsh-decision-engine/providers/laya/shared
 */

import { DecisionError } from '../../core/errors.ts'
import type { DecisionCandidate } from '../../core/types.ts'

/** Serialize a decision state for the model, bounded and explicitly typed. */
export function serializeState(state: unknown, limit: number): string {
  if (typeof state === 'string') return truncate(state, limit)
  try {
    const json = JSON.stringify(state, null, 2)
    if (json === undefined) return String(state)
    return truncate(json, limit)
  } catch (error) {
    throw new DecisionError('invalid_request', `The decision state could not be serialized: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** One model-facing candidate line. */
export function renderCandidate(candidate: DecisionCandidate, metadataLimit: number): string {
  const metadata = candidate.metadata === undefined
    ? ''
    : ` ${truncate(JSON.stringify(candidate.metadata) ?? '{}', metadataLimit)}`
  return `${candidate.id}: ${candidate.description}${metadata}`
}

/**
 * The `choice` question's criteria map: option id → description.
 *
 * The SDK accepts a record or a plain list; a record is used so the option
 * names the model sees are exactly the candidate ids the caller supplied.
 */
export function choiceCriteria(candidates: readonly DecisionCandidate[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const candidate of candidates) criteria[candidate.id] = candidate.description
  return criteria
}

/** Render the full candidate list for a question's instructions. */
export function renderCandidateList(candidates: readonly DecisionCandidate[], metadataLimit: number): string {
  return candidates.map(candidate => renderCandidate(candidate, metadataLimit)).join('\n')
}

/** Whether a value is a plain object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Highest-probability option of a probability map, or undefined. */
export function argmax(probabilities: Record<string, number> | undefined): string | undefined {
  if (probabilities === undefined) return undefined
  let best: { id: string; value: number } | undefined
  for (const [id, value] of Object.entries(probabilities)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (best === undefined || value > best.value) best = { id, value }
  }
  return best?.id
}

/** Entropy-based confidence over a probability distribution, when the SDK did not provide one. */
export function confidenceFromProbabilities(probabilities: Record<string, number> | undefined): number | undefined {
  if (probabilities === undefined) return undefined
  const entries = Object.entries(probabilities).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
  if (entries.length < 2) return undefined
  const total = entries.reduce((sum, [, value]) => sum + Math.max(0, value), 0)
  if (total <= 0) return undefined
  let entropy = 0
  for (const [, value] of entries) {
    const p = Math.max(0, value) / total
    if (p > 0) entropy -= p * Math.log(p)
  }
  const normalized = entropy / Math.log(entries.length)
  return clamp01(1 - normalized)
}

/** Confidence of a binary probability, as distance from the 0.5 midpoint. */
export function confidenceFromBinary(pTrue: number): number {
  return clamp01(Math.abs(clamp01(pTrue) - 0.5) * 2)
}

/** Clamp to the closed unit interval. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Truncate with a visible marker, so a provider can tell content was dropped. */
export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
}
