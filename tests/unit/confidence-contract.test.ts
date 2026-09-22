/**
 * The confidence contract.
 *
 * Confidence numbers are not comparable across providers: a softmax head, a
 * classifier posterior, a rule margin, and an RL value estimate all live on
 * different scales. These tests pin the protocol that keeps them apart:
 *
 * - a confidence number must arrive with a `confidenceKind`;
 * - the engine gates ONLY on `normalized`;
 * - a provider that cannot produce a comparable number says `unavailable`
 *   rather than shipping one the engine would misread.
 *
 * The regression this file exists to prevent: Laya's own entropy confidence
 * (≈0.09 on a real three-way choice) being compared with a threshold calibrated
 * for a normalized scale, which silently made the provider unusable for
 * automatic control.
 *
 * @module dsh-decision-engine/tests/unit/confidence-contract.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionError } from '../../src/core/errors.ts'
import { DecisionProviderRegistry } from '../../src/core/provider-registry.ts'
import { normalizeConfidenceFromDistribution } from '../../src/core/types.ts'
import { normalizeDecisionResult, validateRequest } from '../../src/core/validate.ts'
import { LayaDecisionProvider } from '../../src/providers/laya/provider.ts'
import { QUESTION_KEYS } from '../../src/providers/laya/modes.ts'
import type { DecisionProvider, DecisionRequest } from '../../src/core/types.ts'
import type { LayaAnswerShape, LayaInstance, LayaQuestionShape, LayaSystemOneResult } from '../../src/providers/laya/runtime.ts'
import { ScriptedProvider } from '../helpers.ts'

const REQUEST: DecisionRequest = {
  objective: 'Advance the download dialog',
  state: { window: 'Download', visibleText: 'Download complete' },
  candidates: [
    { id: 'open', description: 'Open the file' },
    { id: 'reveal', description: 'Show in Finder' },
    { id: 'close', description: 'Dismiss' },
  ],
}

function engineWith(provider: DecisionProvider, confidenceThreshold = 0.55): DecisionEngine {
  const registry = new DecisionProviderRegistry()
  registry.register(provider, { enabled: true, config: {} })
  return new DecisionEngine({ defaultProviderId: provider.id, confidenceThreshold }, registry)
}

/** A provider that reports exactly the confidence pair given. */
function confidenceProvider(id: string, confidence: number | undefined, confidenceKind: string | undefined): ScriptedProvider {
  return new ScriptedProvider({
    id,
    plan: () => ({
      provider: id,
      mode: 'choice',
      selected: 'open',
      ...confidence === undefined ? {} : { confidence },
      ...confidenceKind === undefined ? {} : { confidenceKind: confidenceKind as never },
      latencyMs: 0,
    }),
  })
}

describe('confidence must arrive labelled', () => {
  const validated = validateRequest(REQUEST)

  it('accepts a normalized confidence', () => {
    const result = normalizeDecisionResult(
      { selected: 'open', confidence: 0.8, confidenceKind: 'normalized' },
      { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
    )
    assert.equal(result.confidence, 0.8)
    assert.equal(result.confidenceKind, 'normalized')
  })

  it('rejects a bare confidence number with no kind', () => {
    assert.throws(
      () => normalizeDecisionResult({ selected: 'open', confidence: 0.09 }, { providerId: 'laya', mode: 'choice', validated, latencyMs: 1 }),
      (error: unknown) => error instanceof DecisionError
        && error.code === 'invalid_decision'
        && /without a confidenceKind/.test(error.message),
    )
  })

  it('rejects a kind with no number', () => {
    assert.throws(
      () => normalizeDecisionResult({ selected: 'open', confidenceKind: 'normalized' }, { providerId: 'p', mode: 'choice', validated, latencyMs: 1 }),
      (error: unknown) => error instanceof DecisionError && /returned no confidence number/.test(error.message),
    )
  })

  it('rejects an unknown kind', () => {
    assert.throws(
      () => normalizeDecisionResult(
        { selected: 'open', confidence: 0.5, confidenceKind: 'vibes' },
        { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
      ),
      (error: unknown) => error instanceof DecisionError && /unknown confidenceKind/.test(error.message),
    )
  })

  it('rejects "unavailable" carrying a number', () => {
    assert.throws(
      () => normalizeDecisionResult(
        { selected: 'open', confidence: 0.5, confidenceKind: 'unavailable' },
        { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
      ),
      (error: unknown) => error instanceof DecisionError && /together with a number/.test(error.message),
    )
  })

  it('rejects a confidence outside 0..1 regardless of kind', () => {
    assert.throws(
      () => normalizeDecisionResult(
        { selected: 'open', confidence: 7, confidenceKind: 'provider_raw' },
        { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
      ),
      (error: unknown) => error instanceof DecisionError && /outside 0..1/.test(error.message),
    )
  })

  it('accepts "unavailable" with no number as a valid, honest answer', () => {
    const result = normalizeDecisionResult(
      { selected: 'open', confidenceKind: 'unavailable' },
      { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
    )
    assert.equal(result.confidence, undefined)
    assert.equal(result.confidenceKind, 'unavailable')
  })

  it('leaves a result with no confidence fields entirely alone', () => {
    const result = normalizeDecisionResult({ selected: 'open' }, { providerId: 'p', mode: 'choice', validated, latencyMs: 1 })
    assert.equal(result.confidence, undefined)
    assert.equal(result.confidenceKind, undefined)
  })
})

describe('the engine gates only on normalized confidence', () => {
  it('refuses a normalized confidence below the floor', async () => {
    const engine = engineWith(confidenceProvider('normalized-low', 0.093, 'normalized'))
    await assert.rejects(engine.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'low_confidence'
    })
  })

  it('acts on a normalized confidence above the floor', async () => {
    const engine = engineWith(confidenceProvider('normalized-high', 0.71, 'normalized'))
    assert.equal((await engine.decide(REQUEST)).selected, 'open')
  })

  it('does NOT gate on provider_raw, even when it looks tiny', async () => {
    // This is the regression: an entropy confidence of 0.093 on the provider's
    // own scale must not be compared with a normalized threshold.
    const engine = engineWith(confidenceProvider('raw-low', 0.093, 'provider_raw'))
    const result = await engine.decide(REQUEST)
    assert.equal(result.selected, 'open')
    assert.equal(result.confidence, 0.093)
    assert.equal(result.confidenceKind, 'provider_raw')
  })

  it('does NOT gate on unavailable', async () => {
    const engine = engineWith(confidenceProvider('no-confidence', undefined, 'unavailable'))
    const result = await engine.decide(REQUEST)
    assert.equal(result.selected, 'open')
    assert.equal(result.confidenceKind, 'unavailable')
  })

  it('does NOT gate on a provider that reports no confidence at all', async () => {
    const engine = engineWith(confidenceProvider('silent', undefined, undefined))
    assert.equal((await engine.decide(REQUEST)).selected, 'open')
  })

  it('still applies the floor to classification, and still only when normalized', async () => {
    const classified = new ScriptedProvider({
      id: 'classifier',
      plan: () => ({ provider: 'classifier', mode: 'classification', selected: 'open', confidence: 0.2, confidenceKind: 'normalized', latencyMs: 0 }),
    })
    await assert.rejects(engineWith(classified).decide({ ...REQUEST, mode: 'classification' }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'low_confidence'
    })
    const raw = new ScriptedProvider({
      id: 'classifier-raw',
      plan: () => ({ provider: 'classifier-raw', mode: 'classification', selected: 'open', confidence: 0.2, confidenceKind: 'provider_raw', latencyMs: 0 }),
    })
    assert.equal((await engineWith(raw).decide({ ...REQUEST, mode: 'classification' })).selected, 'open')
  })

  it('never gates ranking or score, whatever the kind', async () => {
    for (const kind of ['normalized', 'provider_raw']) {
      const ranker = new ScriptedProvider({
        id: `ranker-${kind}`,
        plan: () => ({
          provider: `ranker-${kind}`,
          mode: 'ranking',
          selected: 'open',
          ranking: [{ id: 'open', score: 1 }, { id: 'reveal', score: 0.5 }],
          confidence: 0.05,
          confidenceKind: kind as never,
          latencyMs: 0,
        }),
      })
      assert.equal((await engineWith(ranker).decide({ ...REQUEST, mode: 'ranking' })).selected, 'open')
    }
  })

  it('reports the kind on the low-confidence failure so the caller can see which scale', async () => {
    const engine = engineWith(confidenceProvider('normalized-low', 0.2, 'normalized'))
    await assert.rejects(engine.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError
        && error.code === 'low_confidence'
        && error.details?.confidenceKind === 'normalized'
    })
  })

  it('a threshold of 0 disables the gate for normalized confidence too', async () => {
    const engine = engineWith(confidenceProvider('normalized-low', 0.01, 'normalized'), 0)
    assert.equal((await engine.decide(REQUEST)).selected, 'open')
  })
})

describe('distribution normalization (a general core helper, not what Laya uses)', () => {
  it('measures dominance, not dispersion', () => {
    // Two three-option ballots with identical option counts and very different
    // decisiveness: only the second should clear any sensible floor.
    const decisive = normalizeConfidenceFromDistribution([
      { id: 'a', probability: 0.97 },
      { id: 'b', probability: 0.02 },
      { id: 'c', probability: 0.01 },
    ])
    const torn = normalizeConfidenceFromDistribution([
      { id: 'a', probability: 0.46 },
      { id: 'b', probability: 0.41 },
      { id: 'c', probability: 0.14 },
    ])
    assert.ok(decisive !== undefined && decisive > 0.9, `decisive was ${decisive}`)
    assert.ok(torn !== undefined && torn < 0.1, `torn was ${torn}`)
  })

  it('is unaffected by how many zero-weight options are on the ballot', () => {
    // Zero-weight entries are not options anyone can choose, so padding the
    // ballot with them must not move the number. This is the invariance entropy
    // confidence lacks: it divides by the option COUNT, so padding changes it.
    const three = normalizeConfidenceFromDistribution([
      { id: 'a', probability: 0.6 },
      { id: 'b', probability: 0.2 },
      { id: 'c', probability: 0.2 },
    ])
    const padded = normalizeConfidenceFromDistribution([
      { id: 'a', probability: 0.6 },
      { id: 'b', probability: 0.2 },
      { id: 'c', probability: 0.2 },
      ...Array.from({ length: 6 }, (_value, index) => ({ id: `x${index}`, probability: 0 })),
    ])
    assert.equal(padded, three)
    // (0.6 − 0.2) / 1.0
    assert.ok(three !== undefined && Math.abs(three - 0.4) < 1e-9)
    // Only the weighted options count, so a bare top-two split is divided by
    // their own total rather than by 1.
    const pair = normalizeConfidenceFromDistribution([
      { id: 'a', probability: 0.6 },
      { id: 'b', probability: 0.2 },
    ])
    assert.ok(pair !== undefined && Math.abs(pair - 0.5) < 1e-9)
  })

  it('returns undefined when there is no contest', () => {
    assert.equal(normalizeConfidenceFromDistribution([]), undefined)
    assert.equal(normalizeConfidenceFromDistribution([{ id: 'a', probability: 1 }]), undefined)
    assert.equal(normalizeConfidenceFromDistribution([
      { id: 'a', probability: 1 },
      { id: 'b', probability: 0 },
    ]), undefined)
  })

  it('ignores non-finite and negative weights', () => {
    const value = normalizeConfidenceFromDistribution([
      { id: 'a', probability: 0.7 },
      { id: 'b', probability: 0.3 },
      { id: 'bad', probability: Number.NaN },
      { id: 'worse', probability: -1 },
      { id: 'infinite', probability: Number.POSITIVE_INFINITY },
    ])
    assert.ok(value !== undefined && Math.abs(value - 0.4) < 1e-9, `value was ${value}`)
  })

  it('clamps to the unit interval', () => {
    const value = normalizeConfidenceFromDistribution([
      { id: 'a', probability: 5 },
      { id: 'b', probability: 1e-12 },
    ])
    assert.ok(value !== undefined && value <= 1 && value >= 0)
  })

})

describe('the Laya provider reports its confidence as provider_raw', () => {
  function fixedLaya(answers: Record<string, LayaAnswerShape>) {
    const instance: LayaInstance = {
      systemOne: (_state, questions: Record<string, LayaQuestionShape>): Promise<LayaSystemOneResult> => {
        const filtered: Record<string, LayaAnswerShape> = {}
        for (const key of Object.keys(questions)) {
          const answer = answers[key]
          if (answer !== undefined) filtered[key] = answer
        }
        return Promise.resolve({ answers: filtered })
      },
      close: () => Promise.resolve(),
    }
    return new LayaDecisionProvider({ instance })
  }

  /**
   * The regression this whole file exists for: Laya's own entropy confidence
   * (a real value of 0.093 on a three-way choice) must never be presented as a
   * normalized confidence, because the engine would then refuse the decision.
   */
  it('never labels the SDK entropy confidence as normalized', async () => {
    const provider = fixedLaya({
      [QUESTION_KEYS.select]: {
        type: 'choice',
        choice: 'open',
        probabilities: { open: 0.663, reveal: 0.161, close: 0.176 },
        confidence: 0.093,
      },
    })
    const result = await provider.decide(REQUEST, { debug: true })
    assert.equal(result.confidenceKind, 'provider_raw')
    assert.equal(result.confidence, 0.093)
    assert.equal(result.debug?.rawConfidence, 0.093)
  })

  it('acts through the engine despite the low raw number', async () => {
    const provider = fixedLaya({
      [QUESTION_KEYS.select]: {
        type: 'choice',
        choice: 'open',
        probabilities: { open: 0.546, reveal: 0.35, close: 0.104 },
        confidence: 0.15,
      },
    })
    const result = await engineWith(provider).decide(REQUEST)
    assert.equal(result.selected, 'open')
    assert.equal(result.confidenceKind, 'provider_raw')
  })

  it('says unavailable — not zero — when the SDK reports no confidence', async () => {
    const provider = fixedLaya({
      [QUESTION_KEYS.select]: { type: 'choice', choice: 'open', probabilities: { open: 0.7, reveal: 0.3 } },
    })
    const result = await provider.decide(REQUEST)
    assert.equal(result.confidence, undefined)
    assert.equal(result.confidenceKind, 'unavailable')
  })

  it('labels the binary noul path provider_raw too', async () => {
    const result = await new LayaDecisionProvider({
      instance: {
        systemOne: () => Promise.resolve({ answers: { [QUESTION_KEYS.binary]: { type: 'noul', noul: 0.9 } } }),
        close: () => Promise.resolve(),
      },
      config: { classificationBinaryMode: 'noul' },
    }).decide({
      objective: 'Decide',
      state: { danger: true },
      candidates: [{ id: 'turn', description: 'Turn' }, { id: 'straight', description: 'Go straight' }],
      mode: 'classification',
    })
    assert.equal(result.selected, 'turn')
    assert.equal(result.confidenceKind, 'provider_raw')
    assert.equal(result.confidence, 0.9)
  })

  it('labels the rating path provider_raw as well', async () => {
    const provider = fixedLaya({
      [`${QUESTION_KEYS.ratePrefix}open`]: { type: 'score', score: 4, confidence: 0.6, legend: {} },
      [`${QUESTION_KEYS.ratePrefix}reveal`]: { type: 'score', score: 2, confidence: 0.4, legend: {} },
      [`${QUESTION_KEYS.ratePrefix}close`]: { type: 'score', score: 0, confidence: 0.2, legend: {} },
    })
    const result = await provider.decide({ ...REQUEST, mode: 'ranking' })
    assert.equal(result.confidenceKind, 'provider_raw')
    // mean of the per-question SDK confidences
    assert.ok(result.confidence !== undefined && Math.abs(result.confidence - 0.4) < 1e-9)
  })

  it('keeps the calibrated-head path open: the label is the only thing to change', async () => {
    // A future calibrated head inside this provider, or any other model, only
    // has to declare `normalized` instead; the engine gate then applies with no
    // change to core.
    const calibrated = confidenceProvider('calibrated', 0.8, 'normalized')
    assert.equal((await engineWith(calibrated).decide(REQUEST)).confidenceKind, 'normalized')
  })
})
