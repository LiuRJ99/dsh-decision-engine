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
import type { DecisionCandidate } from '../../core/types.ts';
/** Serialize a decision state for the model, bounded and explicitly typed. */
export declare function serializeState(state: unknown, limit: number): string;
/** One model-facing candidate line. */
export declare function renderCandidate(candidate: DecisionCandidate, metadataLimit: number): string;
/**
 * The `choice` question's criteria map: option id → description.
 *
 * The SDK accepts a record or a plain list; a record is used so the option
 * names the model sees are exactly the candidate ids the caller supplied.
 */
export declare function choiceCriteria(candidates: readonly DecisionCandidate[]): Record<string, string>;
/** Render the full candidate list for a question's instructions. */
export declare function renderCandidateList(candidates: readonly DecisionCandidate[], metadataLimit: number): string;
/** Whether a value is a plain object (not an array, not null). */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Highest-probability option of a probability map, or undefined. */
export declare function argmax(probabilities: Record<string, number> | undefined): string | undefined;
/**
 * Clamp the SDK's raw confidence into 0..1 without reinterpreting it.
 *
 * The provider deliberately does NOT map this onto a normalized scale. Two
 * independent measurements on the real bundle
 * (`examples/laya-head-calibration.mjs`, `examples/laya-confidence-calibration.mjs`)
 * show there is nothing to map:
 *
 * - the choice head's own entropy-derived confidence barely moves across states
 *   (0.039 for a state carrying no relevant information at all, 0.15 for a clear
 *   decision), so it does not measure uncertainty;
 * - the option-dominance alternative is deterministic per state but ranks a
 *   deliberately torn decision (0.414) ABOVE a clear one (0.196), so it does not
 *   measure decision quality either;
 * - the head applies the temperature vector from `laya_config.json`
 *   (`temperature: [1.64, 1.25, 1.98]`), so the reported probabilities are not
 *   calibrated posteriors to begin with.
 *
 * Inventing a mapping over those numbers would produce a *normalized-looking*
 * value with no relationship to confidence — worse than admitting there is
 * none, because the engine would gate on it. The provider therefore reports
 * `confidenceKind: 'provider_raw'` and the engine leaves the number alone.
 */
export declare function clampRawConfidence(value: unknown): number | undefined;
/** Clamp to the closed unit interval. */
export declare function clamp01(value: number): number;
/** Truncate with a visible marker, so a provider can tell content was dropped. */
export declare function truncate(value: string, limit: number): string;
//# sourceMappingURL=shared.d.ts.map