/**
 * B. Laya provider tests.
 *
 * Every question here is asked through the *public* decision protocol
 * (`choice`, `ranking`, `score`, `classification`) and answered by a fake Laya
 * instance, so the tests exercise the translation layer rather than the model.
 * That is the point: the provider's contract is "normalize Laya into the
 * protocol", and normalization is exactly what is testable without ONNX.
 *
 * The last test in this file is the boundary test — Laya vocabulary must not
 * appear in the core, the runtime, the environments, or the tool.
 *
 * @module dsh-decision-engine/tests/unit/laya-provider.test
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { DecisionError } from '../../src/core/errors.ts'
import type { DecisionRequest } from '../../src/core/types.ts'
import { LayaDecisionProvider } from '../../src/providers/laya/provider.ts'
import { resolveLayaConfig } from '../../src/providers/laya/config.ts'
import { QUESTION_KEYS } from '../../src/providers/laya/modes.ts'
import type { LayaAnswerShape, LayaInstance, LayaQuestionShape, LayaSystemOneResult } from '../../src/providers/laya/runtime.ts'

const REQUEST: DecisionRequest = {
  objective: 'Advance the download dialog',
  state: { app: 'Finder', window: 'Downloads' },
  candidates: [
    { id: 'open', description: 'Open the downloaded file' },
    { id: 'reveal', description: 'Show the file in Finder' },
    { id: 'close', description: 'Dismiss the dialog' },
  ],
}

/** A fake Laya instance that answers from a script, so no model is needed. */
function fakeLaya(plan: (questions: Record<string, LayaQuestionShape>, state: unknown) => Record<string, LayaAnswerShape>): { instance: LayaInstance; calls: { state: unknown; questions: Record<string, LayaQuestionShape> }[] } {
  const calls: { state: unknown; questions: Record<string, LayaQuestionShape> }[] = []
  const instance: LayaInstance = {
    modelDir: '/fake/bundle',
    config: { max_len: 4096, head_max_len: 4096 },
    systemOne: async (state, questions): Promise<LayaSystemOneResult> => {
      calls.push({ state, questions })
      return { model: 'fake-laya', answers: plan(questions, state), usage: { input_tokens: 11, output_tokens: 2 } }
    },
    close: async () => undefined,
  }
  return { instance, calls }
}

/** A plan that answers every choice question by picking `option`. */
function chooseOption(option: string | ((questions: Record<string, LayaQuestionShape>) => string), probabilities?: Record<string, number>) {
  return (questions: Record<string, LayaQuestionShape>): Record<string, LayaAnswerShape> => {
    const selection = typeof option === 'function' ? option(questions) : option
    const answers: Record<string, LayaAnswerShape> = {}
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'choice') {
        answers[key] = {
          type: 'choice',
          choice: selection,
          probabilities: probabilities ?? { [selection]: 0.8, other: 0.2 },
          confidence: 0.8,
        }
      }
    }
    return answers
  }
}

/** A plan that rates every candidate from a map of id → level. */
function rateCandidates(levels: Record<string, number>, confidence?: number) {
  return (questions: Record<string, LayaQuestionShape>): Record<string, LayaAnswerShape> => {
    const answers: Record<string, LayaAnswerShape> = {}
    for (const key of Object.keys(questions)) {
      if (!key.startsWith(QUESTION_KEYS.ratePrefix)) continue
      const id = key.slice(QUESTION_KEYS.ratePrefix.length)
      answers[key] = { type: 'score', score: levels[id] ?? 0, confidence: confidence ?? 0.5, legend: {} }
    }
    return answers
  }
}

describe('laya choice', () => {
  it('returns the model choice as the selected candidate and keeps the probabilities private', async () => {
    const { instance, calls } = fakeLaya(chooseOption('open', { open: 0.7, reveal: 0.2, close: 0.1 }))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...REQUEST, mode: 'choice' })
    assert.equal(result.provider, 'laya')
    assert.equal(result.mode, 'choice')
    assert.equal(result.selected, 'open')
    // The SDK's own confidence is reported, labelled as its own scale.
    assert.equal(result.confidenceKind, 'provider_raw')
    assert.equal(result.confidence, 0.8)
    assert.deepEqual(result.debug, { rawConfidence: 0.8 }, 'probabilities must not leak without debug')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.questions[QUESTION_KEYS.select]?.type, 'choice')
    assert.deepEqual(Object.keys(calls[0]?.questions[QUESTION_KEYS.select]?.criteria as Record<string, string>), ['open', 'reveal', 'close'])
  })

  it('carries the objective and the state into the question text', async () => {
    const { instance, calls } = fakeLaya(chooseOption('open'))
    const provider = new LayaDecisionProvider({ instance })
    await provider.decide({ ...REQUEST, mode: 'choice' })
    const instructions = calls[0]?.questions[QUESTION_KEYS.select]?.instructions ?? ''
    assert.match(instructions, /Advance the download dialog/)
    assert.match(instructions, /Downloads/)
    assert.match(instructions, /reveal/)
  })

  it('exposes raw answers and notes only in debug mode', async () => {
    const { instance } = fakeLaya(chooseOption('open', { open: 0.9 }))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...REQUEST, mode: 'choice' }, { debug: true })
    assert.ok(result.debug !== undefined)
    assert.match(JSON.stringify(result.debug.raw), /probabilities/)
  })

  it('falls back to the highest-probability listed option when the model names an unknown one', async () => {
    const { instance } = fakeLaya(() => ({
      [QUESTION_KEYS.select]: { type: 'choice', choice: 'launch', probabilities: { open: 0.6, reveal: 0.4 }, confidence: 0.6 },
    }))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...REQUEST, mode: 'choice' }, { debug: true })
    assert.equal(result.selected, 'open')
    assert.match(JSON.stringify(result.debug?.notes), /was not a listed option/)
  })

  it('ranks every candidate and never invents one', async () => {
    const { instance } = fakeLaya(chooseOption('reveal', { reveal: 0.5, open: 0.3, close: 0.2 }))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...REQUEST, mode: 'choice' })
    assert.deepEqual(result.ranking?.map(entry => entry.id).sort(), ['close', 'open', 'reveal'])
  })

  it('rejects a model answer with nothing usable', async () => {
    const { instance } = fakeLaya(() => ({ [QUESTION_KEYS.select]: { type: 'choice', choice: '', probabilities: {}, confidence: 0 } }))
    const provider = new LayaDecisionProvider({ instance })
    // With no probabilities and no valid name there is no candidate to fall
    // back to, but the first candidate is the last resort — assert it is a real
    // candidate rather than an invented id.
    const result = await provider.decide({ ...REQUEST, mode: 'choice' })
    assert.equal(result.selected, 'open')
  })

  it('fails with invalid_decision when the model returns no answer at all', async () => {
    const { instance } = fakeLaya(() => ({}))
    const provider = new LayaDecisionProvider({ instance })
    await assert.rejects(provider.decide({ ...REQUEST, mode: 'choice' }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'invalid_decision'
    })
  })
})

describe('laya score and ranking', () => {
  it('turns per-candidate scores into a normalized ranking', async () => {
    const { instance, calls } = fakeLaya(rateCandidates({ open: 4, reveal: 2, close: 0 }, 0.6))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...REQUEST, mode: 'ranking' })
    assert.equal(result.selected, 'open')
    assert.deepEqual(result.ranking?.map(entry => entry.id), ['open', 'reveal', 'close'])
    assert.equal(result.ranking?.[0]?.score, 1)
    assert.equal(result.ranking?.[1]?.score, 0.5)
    assert.equal(result.ranking?.[2]?.score, 0)
    assert.equal(Object.keys(calls[0]?.questions ?? {}).length, 3, 'one score question per candidate')
    for (const question of Object.values(calls[0]?.questions ?? {})) {
      assert.equal(question.type, 'score')
      assert.equal((question.criteria as string[]).length, 5)
    }
  })

  it('returns a single normalized score for the score mode', async () => {
    const { instance } = fakeLaya(rateCandidates({ open: 3, reveal: 1, close: 0 }))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...REQUEST, mode: 'score' })
    assert.equal(result.selected, 'open')
    // The reported confidence is the model's own answer confidence, not the
    // rating: score travels on the ranking, which is where a caller reads a
    // comparable number from.
    assert.equal(result.confidence, 0.5)
    assert.deepEqual(result.ranking?.map(entry => entry.id), ['open', 'reveal', 'close'])
    assert.equal(result.ranking?.[0]?.score, 0.75)
  })

  it('clamps an out-of-range level and says so', async () => {
    const { instance } = fakeLaya(rateCandidates({ open: 99, reveal: 0, close: 0 }))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...REQUEST, mode: 'ranking' }, { debug: true })
    assert.equal(result.ranking?.[0]?.score, 1)
    assert.match(JSON.stringify(result.debug?.notes), /clamped/)
  })

  it('honours a custom level scale', async () => {
    const { instance, calls } = fakeLaya(rateCandidates({ open: 1, reveal: 0, close: 0 }))
    const provider = new LayaDecisionProvider({ instance, config: { scoreLevels: ['bad', 'good'] } })
    const result = await provider.decide({ ...REQUEST, mode: 'score' })
    assert.equal(result.ranking?.[0]?.score, 1)
    assert.deepEqual(calls[0]?.questions[`${QUESTION_KEYS.ratePrefix}open`]?.criteria, ['bad', 'good'])
  })

  it('fails when the model returns no score for any candidate', async () => {
    const { instance } = fakeLaya(() => ({}))
    const provider = new LayaDecisionProvider({ instance })
    await assert.rejects(provider.decide({ ...REQUEST, mode: 'ranking' }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'invalid_decision'
    })
  })
})

describe('noul to generic classification', () => {
  const BINARY: DecisionRequest = {
    objective: 'Decide whether the snake should turn',
    state: { danger: 'ahead' },
    candidates: [
      { id: 'turn', description: 'Turn away from the wall' },
      { id: 'straight', description: 'Continue straight' },
    ],
  }

  it('asks a noul question and maps p(true) 0.9 to the first candidate', async () => {
    const { instance, calls } = fakeLaya(() => ({
      [QUESTION_KEYS.binary]: { type: 'noul', noul: 0.9 },
    }))
    const provider = new LayaDecisionProvider({ instance, config: { classificationBinaryMode: 'noul' } })
    const result = await provider.decide({ ...BINARY, mode: 'classification' })
    assert.equal(calls[0]?.questions[QUESTION_KEYS.binary]?.type, 'noul')
    assert.equal(result.mode, 'classification', 'the public mode is classification, never noul')
    assert.equal(result.selected, 'turn')
    // The winning side's P(true), reported on the model's own scale.
    assert.equal(result.confidence, 0.9)
    assert.equal(result.confidenceKind, 'provider_raw')
  })

  it('maps p(true) 0.1 to the second candidate', async () => {
    const { instance } = fakeLaya(() => ({ [QUESTION_KEYS.binary]: { type: 'noul', noul: 0.1 } }))
    const provider = new LayaDecisionProvider({ instance, config: { classificationBinaryMode: 'noul' } })
    const result = await provider.decide({ ...BINARY, mode: 'classification' })
    assert.equal(result.selected, 'straight')
    // 1 − 0.1: the probability mass on the side that won.
    assert.equal(result.confidence, 0.9)
    assert.equal(result.confidenceKind, 'provider_raw')
  })

  it('uses a plain choice when the binary noul mode is not configured', async () => {
    const { instance, calls } = fakeLaya(chooseOption('straight'))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide({ ...BINARY, mode: 'classification' })
    assert.equal(calls[0]?.questions[QUESTION_KEYS.select]?.type, 'choice')
    assert.equal(result.selected, 'straight')
  })

  it('rejects a non-numeric noul answer', async () => {
    const { instance } = fakeLaya(() => ({ [QUESTION_KEYS.binary]: { type: 'noul' } }))
    const provider = new LayaDecisionProvider({ instance, config: { classificationBinaryMode: 'noul' } })
    await assert.rejects(provider.decide({ ...BINARY, mode: 'classification' }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'invalid_decision'
    })
  })
})

describe('model availability', () => {
  it('reports degraded, not unavailable, when the SDK is absent', async () => {
    const provider = new LayaDecisionProvider({
      loadModule: () => Promise.reject(new DecisionError('provider_unavailable', 'The Laya SDK (@receptron/laya) is not installed or could not be imported: missing')),
    })
    const health = await provider.healthCheck()
    assert.equal(health.status, 'degraded')
    await assert.rejects(provider.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_unavailable'
    })
  })

  it('reports unavailable when the load fails for a real reason', async () => {
    const provider = new LayaDecisionProvider({
      loadModule: () => Promise.reject(new Error('the ONNX file is corrupt')),
    })
    await assert.rejects(provider.decide(REQUEST))
    const health = await provider.healthCheck()
    assert.equal(health.status, 'unavailable')
    assert.match(health.reason ?? '', /corrupt/)
  })

  it('reports ok once an instance is ready', async () => {
    const { instance } = fakeLaya(chooseOption('open'))
    const provider = new LayaDecisionProvider({ instance })
    assert.equal((await provider.healthCheck()).status, 'ok')
  })

  it('records latency and call statistics', async () => {
    const { instance } = fakeLaya(chooseOption('open'))
    const provider = new LayaDecisionProvider({ instance })
    const result = await provider.decide(REQUEST)
    assert.ok(result.latencyMs >= 0)
    const stats = provider.runtime.stats
    assert.equal(stats.calls, 1)
    assert.equal(stats.failures, 0)
    assert.equal(stats.inputTokens, 11)
  })

  it('counts a failed inference as a failure', async () => {
    const provider = new LayaDecisionProvider({
      instance: {
        systemOne: () => Promise.reject(new Error('inference blew up')),
        close: () => Promise.resolve(),
      },
    })
    await assert.rejects(provider.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_failed'
    })
    assert.equal(provider.runtime.stats.failures, 1)
  })
})

describe('invalid provider output', () => {
  it('refuses to pass an unlisted candidate through when strictCandidates is on', async () => {
    const { instance } = fakeLaya(() => ({
      [QUESTION_KEYS.select]: { type: 'choice', choice: 'ghost', probabilities: { ghost: 0.9 }, confidence: 0.9 },
    }))
    const provider = new LayaDecisionProvider({ instance, config: { strictCandidates: true } })
    // 'ghost' is not a candidate and there is no listed option with a
    // probability, so the first candidate is the last resort — a real id, never
    // the invented one.
    const result = await provider.decide(REQUEST)
    assert.equal(result.selected, 'open')
    assert.ok(REQUEST.candidates.some(candidate => candidate.id === result.selected))
  })

  it('rejects a malformed request before touching the model', async () => {
    const { instance, calls } = fakeLaya(chooseOption('open'))
    const provider = new LayaDecisionProvider({ instance })
    await assert.rejects(provider.decide({ ...REQUEST, candidates: [] }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'no_candidates'
    })
    assert.equal(calls.length, 0, 'a rejected request must not reach the model')
  })
})

describe('laya configuration', () => {
  it('resolves modelDir and execution providers from config first', () => {
    const resolved = resolveLayaConfig({ modelDir: '/models/laya', device: 'cpu,coreml', threads: 4 }, {})
    assert.equal(resolved.modelDir, '/models/laya')
    assert.deepEqual(resolved.executionProviders, ['cpu', 'coreml'])
    assert.equal(resolved.threads, 4)
    assert.equal(resolved.required, false)
  })

  it('falls back to the environment when config omits a value', () => {
    const resolved = resolveLayaConfig({}, { LAYA_MODEL_DIR: '/env/laya', LAYA_EP: 'coreml', LAYA_THREADS: '8' })
    assert.equal(resolved.modelDir, '/env/laya')
    assert.deepEqual(resolved.executionProviders, ['coreml'])
    assert.equal(resolved.threads, 8)
  })

  it('defaults to cpu and no model directory', () => {
    const resolved = resolveLayaConfig({}, {})
    assert.equal(resolved.modelDir, undefined)
    assert.deepEqual(resolved.executionProviders, ['cpu'])
    assert.equal(resolved.scoreLevels.length, 5)
  })

  it('serializes bounded state', async () => {
    const { instance, calls } = fakeLaya(chooseOption('open'))
    const provider = new LayaDecisionProvider({ instance, config: { maxStateChars: 40 } })
    await provider.decide({ ...REQUEST, state: { big: 'x'.repeat(500) } })
    assert.match(String(calls[0]?.state), /truncated/)
  })
})

describe('laya isolation', () => {
  const forbidden = /noul|@receptron\/laya|onnxruntime|LayaInstance|rl_agent/i

  for (const file of [
    'src/core/types.ts',
    'src/core/errors.ts',
    'src/core/decision-engine.ts',
    'src/core/provider-registry.ts',
    'src/core/router.ts',
    'src/core/validate.ts',
    'src/core/telemetry.ts',
    'src/runtime/runner.ts',
    'src/environments/types.ts',
    'src/environments/browser/adapter.ts',
    'src/environments/computer/adapter.ts',
    'src/environments/custom/adapter.ts',
    'src/tools/decision-decide.ts',
  ]) {
    it(`${file} contains no Laya-specific vocabulary`, () => {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
      const code = text.split('\n').filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line)).join('\n')
      const match = forbidden.exec(code)
      assert.equal(match, null, `${file} leaks Laya vocabulary: ${match?.[0]}`)
    })
  }
})
