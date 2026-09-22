/**
 * Telemetry records emitted by the decision engine and the runtime.
 *
 * The record is deliberately flat, small, and free of environment payloads:
 * it carries counts, ids, timings, and the chosen id — never page text,
 * accessibility trees, form values, or credentials. A sink that persists these
 * records therefore cannot persist user content by accident.
 *
 * @module dsh-decision-engine/core/telemetry
 */

import type { DecisionErrorCode } from './errors.ts'
import type { DecisionConfidenceKind, DecisionMode } from './types.ts'

/** Which layer a timing belongs to, so a slow environment is never blamed on a slow model. */
export interface DecisionTimings {
  /** Time spent producing the observation, in milliseconds. */
  observeMs?: number
  /** Time spent inside the provider, in milliseconds. */
  decisionMs?: number
  /** Time spent mapping the decision to a concrete action, in milliseconds. */
  mapMs?: number
  /** Time spent executing the mapped action, in milliseconds. */
  executeMs?: number
  /** Wall-clock time for the whole operation, in milliseconds. */
  totalMs: number
}

/** One telemetry record. Emitted per decision and per runtime step. */
export interface DecisionTelemetry {
  /** What produced the record: a bare decision call or a runtime step. */
  kind: 'decision' | 'step'
  /** Environment id, when one was involved. */
  environment?: string
  /** Provider id the call routed to, when one was reached. */
  provider?: string
  /** Requested capability. */
  mode?: DecisionMode
  /** How many candidates the request carried. */
  candidateCount?: number
  /** Selected candidate id, when the call succeeded. */
  selected?: string
  /** Confidence value, when the provider produced one. */
  confidence?: number
  /** What that confidence number is (`normalized` / `provider_raw` / `unavailable`). */
  confidenceKind?: DecisionConfidenceKind
  /** Runtime step index, for step records. */
  step?: number
  /** Escalation or failure reason, when the operation did not proceed. */
  escalationReason?: DecisionErrorCode
  /** Per-layer timings. */
  timings: DecisionTimings
}

/** A telemetry consumer. Implementations must not throw; the engine contains their failures. */
export type DecisionTelemetrySink = (record: DecisionTelemetry) => void

/** A telemetry sink that keeps the most recent records in memory (bounded). */
export function createRingBufferSink(limit = 200): { sink: DecisionTelemetrySink; records: DecisionTelemetry[] } {
  const records: DecisionTelemetry[] = []
  return {
    records,
    sink: (record) => {
      records.push(record)
      if (records.length > limit) records.splice(0, records.length - limit)
    },
  }
}
