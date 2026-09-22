/**
 * Laya mode translators.
 *
 * The public capability vocabulary is `choice | ranking | score |
 * classification`. Laya's own question vocabulary is `choice | score | noul`.
 * This file is the whole translation between them, in both directions:
 *
 * | public mode      | Laya question(s)                        | normalization                              |
 * | ---------------- | --------------------------------------- | ------------------------------------------ |
 * | `choice`         | one `choice` over the candidate ids     | winner + probabilities → `selected`, ranks  |
 * | `ranking`        | one `score` per candidate               | level → 0..1 score → ordered ranking        |
 * | `score`          | one `score` for the selected candidate  | level → 0..1 `confidence` + one-entry rank  |
 * | `classification` | `choice`, or one `noul` when binary     | winner (or p(true)) → `selected`           |
 *
 * ## Confidence: what this provider does and does not claim
 *
 * Laya reports a confidence on its own scale (`1 − normalized entropy` for a
 * `choice` answer, `P(true)` for `noul`). This provider publishes it verbatim
 * with `confidenceKind: 'provider_raw'`, which tells the engine **not** to
 * compare it with a normalized threshold. `debug.rawConfidence` carries the
 * same number for a reader who wants it without the protocol field.
 *
 * That is a measured decision, not caution. On the real bundle the number does
 * not track anything an action gate cares about: a state carrying no relevant
 * information scores 0.039 while a clear decision scores 0.15, and the
 * option-dominance alternative ranks a deliberately torn decision (0.414)
 * above a clear one (0.196). See `clampRawConfidence` in `shared.ts` and
 * `examples/laya-head-calibration.mjs` for the measurements.
 *
 * A provider that *can* produce a comparable confidence declares
 * `confidenceKind: 'normalized'` instead; only those are gated. Adding a
 * calibrated head to this provider later means changing that one label.
 *
 * `noul` appears only in this file. It is a Laya-private concept: the core has
 * no capability for it, and the only thing that leaves this module is a
 * generic classification answer. The same is true of `criteria`,
 * `instructions`, `probabilities`, `rl_agent`, and `legend` — all Laya
 * vocabulary, all contained here and in `runtime.ts`.
 *
 * @module dsh-decision-engine/providers/laya/modes
 */
import { type ValidatedRequest } from '../../core/validate.ts';
import type { DecisionMode, DecisionRankEntry, DecisionResult } from '../../core/types.ts';
import type { ResolvedLayaConfig } from './config.ts';
import type { LayaQuestionShape, LayaSystemOneResult } from './runtime.ts';
/** One planned question: its key in the Laya response and the question itself. */
export interface PlannedQuestion {
    /** Key the answer arrives under (`select`, `rate::<candidateId>`, `binary`). */
    key: string;
    question: LayaQuestionShape;
    /** Candidate this question is about, when it rates one. */
    candidateId?: string;
}
/** A plan: the questions plus the state text they are all asked about. */
export interface QuestionPlan {
    /** Serialized state handed to the model. */
    state: string;
    questions: PlannedQuestion[];
}
/** What a translator produced. */
export interface TranslatedAnswer {
    /** Candidate the model selected, when the mode selects one. */
    selected: string | undefined;
    /** Ranked entries, best first. */
    ranking: DecisionRankEntry[];
    /**
     * The model's own confidence, verbatim, on the model's own scale. Published
     * as `confidenceKind: 'provider_raw'`; never gated on.
     */
    confidence: number | undefined;
    /** Normalized 0..1 score for the selected candidate, when the mode has one. */
    score: number | undefined;
    /** Provider-private raw detail for debug output. */
    raw: Record<string, unknown>;
    /** Non-fatal notes worth surfacing in debug output. */
    notes: string[];
}
/** Keys used inside the Laya response. Stable, so a debug reader can rely on them. */
export declare const QUESTION_KEYS: {
    readonly select: "select";
    readonly binary: "binary";
    readonly ratePrefix: "rate::";
};
/**
 * Plan the questions for a request.
 *
 * @param mode - the public capability to exercise.
 * @param validated - the validated request.
 * @param config - resolved Laya config.
 */
export declare function planQuestions(mode: DecisionMode, validated: ValidatedRequest, config: ResolvedLayaConfig): QuestionPlan;
/**
 * Interpret the model's answers for a plan.
 *
 * Robustness rules, all of them deliberate:
 * - a `choice` answer naming an unknown or empty option falls back to the
 *   highest-probability known option, and says so in `notes`;
 * - a `score` answer outside the level range is clamped;
 * - a missing confidence is derived from the distribution (choice) or the
 *   distance from 0.5 (binary classification).
 *
 * It never invents a candidate: if nothing usable remains, it throws.
 */
export declare function translateAnswers(mode: DecisionMode, plan: QuestionPlan, result: LayaSystemOneResult, config: ResolvedLayaConfig, candidateIds: readonly string[]): TranslatedAnswer;
/** Assemble the protocol result from a translated answer + metadata. */
export declare function toResult(translated: TranslatedAnswer, options: {
    providerId: string;
    mode: DecisionMode;
    latencyMs: number;
    includeDebug: boolean;
    /** Input tokens the SDK reported for this call, when it reported them. */
    inputTokens?: number;
}): DecisionResult;
//# sourceMappingURL=modes.d.ts.map