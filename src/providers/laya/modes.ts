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

import { DecisionError } from '../../core/errors.ts'
import { rankByScore, type ValidatedRequest } from '../../core/validate.ts'
import type { DecisionMode, DecisionRankEntry, DecisionResult } from '../../core/types.ts'
import type { ResolvedLayaConfig } from './config.ts'
import { fillTemplate } from './config.ts'
import type { LayaAnswerShape, LayaQuestionShape, LayaSystemOneResult } from './runtime.ts'
import {
  argmax,
  choiceCriteria,
  clampRawConfidence,
  renderCandidateList,
  serializeState,
} from './shared.ts'

/** One planned question: its key in the Laya response and the question itself. */
export interface PlannedQuestion {
  /** Key the answer arrives under (`select`, `rate::<candidateId>`, `binary`). */
  key: string
  question: LayaQuestionShape
  /** Candidate this question is about, when it rates one. */
  candidateId?: string
}

/** A plan: the questions plus the state text they are all asked about. */
export interface QuestionPlan {
  /** Serialized state handed to the model. */
  state: string
  questions: PlannedQuestion[]
}

/** What a translator produced. */
export interface TranslatedAnswer {
  /** Candidate the model selected, when the mode selects one. */
  selected: string | undefined
  /** Ranked entries, best first. */
  ranking: DecisionRankEntry[]
  /**
   * The model's own confidence, verbatim, on the model's own scale. Published
   * as `confidenceKind: 'provider_raw'`; never gated on.
   */
  confidence: number | undefined
  /** Normalized 0..1 score for the selected candidate, when the mode has one. */
  score: number | undefined
  /** Provider-private raw detail for debug output. */
  raw: Record<string, unknown>
  /** Non-fatal notes worth surfacing in debug output. */
  notes: string[]
}

/** Keys used inside the Laya response. Stable, so a debug reader can rely on them. */
export const QUESTION_KEYS = {
  select: 'select',
  binary: 'binary',
  ratePrefix: 'rate::',
} as const

/** The objective line shared by every instruction template. */
function objectiveLine(objective: string | undefined): string {
  return objective === undefined || objective.trim() === '' ? '(not specified)' : objective
}

/**
 * Plan the questions for a request.
 *
 * @param mode - the public capability to exercise.
 * @param validated - the validated request.
 * @param config - resolved Laya config.
 */
export function planQuestions(mode: DecisionMode, validated: ValidatedRequest, config: ResolvedLayaConfig): QuestionPlan {
  const { request, byId } = validated
  const candidates = request.candidates
  const state = serializeState(request.state, config.maxStateChars)
  const constraints = request.constraints === undefined || request.constraints.length === 0
    ? ''
    : `\nConstraints:\n${request.constraints.map(item => `- ${item}`).join('\n')}`
  const objective = objectiveLine(request.objective)

  if (mode === 'choice') {
    return {
      state,
      questions: [{
        key: QUESTION_KEYS.select,
        question: {
          type: 'choice',
          instructions: `${fillTemplate(config.choiceInstructions, { objective, count: candidates.length })}\n\nState:\n${state}${constraints}\n\nOptions:\n${renderCandidateList(candidates, config.maxCandidateMetadataChars)}`,
          criteria: choiceCriteria(candidates),
        },
      }],
    }
  }

  if (mode === 'classification') {
    if (candidates.length === 2 && config.classificationBinaryMode === 'noul') {
      const first = candidates[0]
      const second = candidates[1]
      if (first === undefined || second === undefined) {
        throw new DecisionError('invalid_decision', 'Binary classification requires exactly two candidates.')
      }
      void byId
      return {
        state,
        questions: [{
          key: QUESTION_KEYS.binary,
          question: {
            type: 'noul',
            instructions: `${fillTemplate(config.noulInstructions, { objective, first: first.id, second: second.id })}\n\nState:\n${state}${constraints}\n\nOption 1 (${first.id}): ${first.description}\nOption 2 (${second.id}): ${second.description}`,
            criteria: { true: first.description, false: second.description },
          },
        }],
      }
    }
    return {
      state,
      questions: [{
        key: QUESTION_KEYS.select,
        question: {
          type: 'choice',
          instructions: `Classify the state into exactly one option.\nObjective: ${objective}\n\nState:\n${state}${constraints}\n\nOptions:\n${renderCandidateList(candidates, config.maxCandidateMetadataChars)}`,
          criteria: choiceCriteria(candidates),
        },
      }],
    }
  }

  // ranking and score both rate candidates on the same ordered scale.
  const questions: PlannedQuestion[] = candidates.map(candidate => ({
    key: `${QUESTION_KEYS.ratePrefix}${candidate.id}`,
    candidateId: candidate.id,
    question: {
      type: 'score',
      instructions: `${fillTemplate(config.scoreInstructions, { objective, count: candidates.length })}\n\nState:\n${state}${constraints}\n\nThe option to rate is "${candidate.id}": ${candidate.description}`,
      criteria: [...config.scoreLevels],
    },
  }))
  return { state, questions }
}

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
export function translateAnswers(
  mode: DecisionMode,
  plan: QuestionPlan,
  result: LayaSystemOneResult,
  config: ResolvedLayaConfig,
  candidateIds: readonly string[],
): TranslatedAnswer {
  const notes: string[] = []
  const candidates = new Set(candidateIds)

  if (mode === 'choice' || (mode === 'classification' && plan.questions[0]?.question.type === 'choice')) {
    const answer = result.answers[QUESTION_KEYS.select]
    if (answer === undefined) {
      throw new DecisionError('invalid_decision', 'Laya returned no answer for the choice question.', { subject: 'laya' })
    }
    const probabilities = sanitizeProbabilities(answer.probabilities, candidates)
    let selected = typeof answer.choice === 'string' && candidates.has(answer.choice) ? answer.choice : undefined
    if (selected === undefined) {
      const fallback = argmax(probabilities) ?? candidateIds[0]
      if (fallback !== undefined && candidates.has(fallback)) {
        selected = fallback
        notes.push(answer.probabilities === undefined
          ? 'The model returned no usable option; used the first candidate.'
          : `The model's choice ${JSON.stringify(answer.choice ?? null)} was not a listed option; used the highest-probability option instead.`)
      }
    }
    if (selected === undefined) {
      throw new DecisionError('invalid_decision', 'Laya produced no usable option for the choice question.', { subject: 'laya' })
    }
    const ranking = rankingFromProbabilities(probabilities, candidateIds, selected)
    return {
      selected,
      ranking,
      // Verbatim SDK confidence. Labelled `provider_raw` by `toResult`, so the
      // engine reports it and never gates on it.
      confidence: clampRawConfidence(answer.confidence),
      score: scoreOf(ranking, selected),
      raw: { [QUESTION_KEYS.select]: answer },
      notes,
    }
  }

  if (mode === 'classification' && plan.questions[0]?.question.type === 'noul') {
    const answer = result.answers[QUESTION_KEYS.binary]
    if (answer === undefined || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
      throw new DecisionError('invalid_decision', 'Laya returned no numeric noul answer for the binary classification.', { subject: 'laya' })
    }
    const pTrue = clampRawConfidence(answer.noul) ?? 0
    const first = candidateIds[0]
    const second = candidateIds[1]
    if (first === undefined || second === undefined) {
      throw new DecisionError('invalid_decision', 'Binary classification requires exactly two candidates.', { subject: 'laya' })
    }
    const selected = pTrue >= 0.5 ? first : second
    notes.push(`noul ${pTrue.toFixed(4)} mapped to the generic classification result (threshold 0.5).`)
    const dominance = pTrue >= 0.5 ? pTrue : 1 - pTrue
    return {
      selected,
      ranking: [
        { id: selected, score: dominance },
        { id: selected === first ? second : first, score: 1 - dominance },
      ],
      // `noul` has no separate confidence field; the winning side's probability
      // is the model's own number, reported as provider_raw like the rest.
      confidence: clampRawConfidence(dominance),
      score: dominance,
      raw: { [QUESTION_KEYS.binary]: answer },
      notes,
    }
  }

  // ranking / score: one score answer per candidate.
  const maxLevel = Math.max(1, config.scoreLevels.length - 1)
  const entries: { id: string; score: number }[] = []
  const confidences: number[] = []
  const raw: Record<string, unknown> = {}
  for (const planned of plan.questions) {
    const candidateId = planned.candidateId
    if (candidateId === undefined) continue
    const answer: LayaAnswerShape | undefined = result.answers[planned.key]
    raw[planned.key] = answer
    const level = answer?.score
    if (typeof level !== 'number' || !Number.isFinite(level)) {
      notes.push(`The model returned no score for "${candidateId}".`)
      continue
    }
    const clamped = Math.min(maxLevel, Math.max(0, level))
    if (clamped !== level) notes.push(`Score ${level} for "${candidateId}" was clamped to the ${config.scoreLevels.length}-level scale.`)
    entries.push({ id: candidateId, score: clamped / maxLevel })
    if (typeof answer?.confidence === 'number' && Number.isFinite(answer.confidence)) confidences.push(answer.confidence)
  }
  if (entries.length === 0) {
    throw new DecisionError('invalid_decision', 'Laya returned no usable score for any candidate.', { subject: 'laya' })
  }
  const ranking = rankByScore(entries)
  const selected = ranking[0]?.id
  if (selected === undefined) {
    throw new DecisionError('invalid_decision', 'Laya produced no ranked candidate.', { subject: 'laya' })
  }
  // A rating question returns a level, not a distribution, so there is no
  // comparable dominance to report. The per-question confidences are the SDK's
  // own scale and stay in the raw payload; `confidenceKind` will be
  // `unavailable`, which is exactly what "this answer shape cannot produce a
  // comparable confidence" means.
  const meanConfidence = confidences.length === 0 ? undefined : confidences.reduce((sum, value) => sum + value, 0) / confidences.length
  return {
    selected,
    ranking,
    confidence: meanConfidence === undefined ? undefined : clampRawConfidence(meanConfidence),
    score: scoreOf(ranking, selected),
    raw,
    notes,
  }
}

/** Keep only probabilities that name real candidates, with finite non-negative values. */
function sanitizeProbabilities(probabilities: Record<string, number> | undefined, candidates: Set<string>): Record<string, number> | undefined {
  if (probabilities === undefined) return undefined
  const cleaned: Record<string, number> = {}
  for (const [id, value] of Object.entries(probabilities)) {
    if (!candidates.has(id)) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    cleaned[id] = value
  }
  return Object.keys(cleaned).length === 0 ? undefined : cleaned
}

/** Order candidates by descending probability, keeping every candidate in the result. */
function rankingFromProbabilities(probabilities: Record<string, number> | undefined, candidateIds: readonly string[], selected: string): DecisionRankEntry[] {
  const entries = candidateIds.map((id) => {
    const probability = probabilities?.[id]
    return typeof probability === 'number' && Number.isFinite(probability) ? { id, score: probability } : { id }
  })
  const ranked = rankByScore(entries)
  if (ranked[0]?.id !== selected) {
    const without = ranked.filter(entry => entry.id !== selected)
    return [{ id: selected, ...probabilities?.[selected] === undefined ? {} : { score: probabilities[selected] } }, ...without]
  }
  return ranked
}

function scoreOf(ranking: DecisionRankEntry[], selected: string): number | undefined {
  return ranking.find(entry => entry.id === selected)?.score
}

/** Assemble the protocol result from a translated answer + metadata. */
export function toResult(
  translated: TranslatedAnswer,
  options: { providerId: string; mode: DecisionMode; latencyMs: number; includeDebug: boolean },
): DecisionResult {
  const debug = {
    ...options.includeDebug ? { raw: translated.raw } : {},
    ...translated.confidence === undefined ? {} : { rawConfidence: translated.confidence },
    ...translated.notes.length === 0 ? {} : { notes: translated.notes },
  }
  const hasDebug = options.includeDebug || translated.confidence !== undefined || translated.notes.length > 0
  // Every confidence this provider produces is on Laya's own scale, so it is
  // labelled `provider_raw`: the engine reports it and never compares it with a
  // normalized threshold. When the SDK gives no number at all the label is
  // `unavailable` — an honest absence, not a zero. A calibrated head added to
  // this provider later changes this one line.
  const confidenceKind = translated.confidence === undefined ? 'unavailable' as const : 'provider_raw' as const
  return {
    provider: options.providerId,
    mode: options.mode,
    ...translated.selected === undefined ? {} : { selected: translated.selected },
    ranking: translated.ranking,
    ...translated.confidence === undefined ? {} : { confidence: translated.confidence },
    confidenceKind,
    latencyMs: options.latencyMs,
    ...hasDebug ? { debug } : {},
  }
}
