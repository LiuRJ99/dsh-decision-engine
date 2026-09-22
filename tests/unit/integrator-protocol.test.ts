/**
 * Integrator-facing protocol fixes.
 *
 * Every test here comes from real friction an external integrator hit while
 * embedding this layer (the laya-router migration), not from speculation:
 *
 * 1. a composite provider could not tell which of its arms answered, because the
 *    engine stamped its own id over the result;
 * 2. token accounting was not part of the protocol, so an integrator reached into
 *    a provider's private runtime statistics to count tokens;
 * 3. a shared `CustomEnvironmentAdapter` failed a *valid* decision with
 *    `unknown_candidate` as soon as a second caller observed the environment —
 *    the candidate set was single-slot instance state.
 *
 * @module dsh-decision-engine/tests/unit/integrator-protocol.test.ts
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionError } from '../../src/core/errors.ts'
import { DecisionProviderRegistry } from '../../src/core/provider-registry.ts'
import { normalizeDecisionResult, validateRequest } from '../../src/core/validate.ts'
import { CustomEnvironmentAdapter } from '../../src/environments/custom/adapter.ts'
import type { DecisionProvider, DecisionRequest, DecisionResult } from '../../src/core/types.ts'
import { ScriptedProvider } from '../helpers.ts'

const REQUEST: DecisionRequest = {
  objective: 'Choose',
  state: { a: 1 },
  candidates: [{ id: 'x', description: 'X' }, { id: 'y', description: 'Y' }],
}

describe('a provider may name the arm that answered', () => {
  const validated = validateRequest(REQUEST)

  it('keeps an explicit provider id from the provider', () => {
    const result = normalizeDecisionResult(
      { provider: 'rules', selected: 'x' },
      { providerId: 'laya-with-fallback', mode: 'choice', validated, latencyMs: 1 },
    )
    assert.equal(result.provider, 'rules', 'the registered id must not overwrite the answering arm')
  })

  it('stamps the registered id when the provider names none', () => {
    const result = normalizeDecisionResult(
      { selected: 'x' },
      { providerId: 'laya-with-fallback', mode: 'choice', validated, latencyMs: 1 },
    )
    assert.equal(result.provider, 'laya-with-fallback')
  })

  it('ignores an empty or non-string provider name', () => {
    for (const provider of ['', '   ', 42, null]) {
      const result = normalizeDecisionResult(
        { provider, selected: 'x' },
        { providerId: 'registered', mode: 'choice', validated, latencyMs: 1 },
      )
      assert.equal(result.provider, 'registered')
    }
  })

  it('lets a composite provider report its arm through the engine', async () => {
    let calls = 0
    const composite: DecisionProvider = {
      id: 'composite',
      capabilities: ['choice'],
      decide: (request) => {
        calls += 1
        // First call answers from the model arm, second from the local one.
        const arm = calls === 1 ? 'laya' : 'rules'
        const selected = request.candidates[0]?.id
        return Promise.resolve({ provider: arm, mode: 'choice', ...selected === undefined ? {} : { selected }, latencyMs: 0 })
      },
    }
    const registry = new DecisionProviderRegistry()
    registry.register(composite, { enabled: true })
    const engine = new DecisionEngine({ defaultProviderId: 'composite' }, registry)
    assert.equal((await engine.decide(REQUEST)).provider, 'laya')
    assert.equal((await engine.decide(REQUEST)).provider, 'rules')
  })
})

describe('token usage is part of the protocol', () => {
  it('carries usage through normalization', () => {
    const validated = validateRequest(REQUEST)
    const result = normalizeDecisionResult(
      { selected: 'x', usage: { inputTokens: 225, outputTokens: 2 } },
      { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
    )
    assert.deepEqual(result.usage, { inputTokens: 225, outputTokens: 2 })
  })

  it('drops nonsense counters instead of failing a good decision', () => {
    const validated = validateRequest(REQUEST)
    for (const usage of [
      { inputTokens: -5 },
      { inputTokens: Number.NaN },
      { inputTokens: 'many' },
      {},
      'nope',
      null,
    ]) {
      const result = normalizeDecisionResult(
        { selected: 'x', usage },
        { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
      )
      assert.equal(result.usage, undefined, `usage ${JSON.stringify(usage)} should have been dropped`)
    }
  })

  it('keeps provider-specific metrics when they are finite numbers', () => {
    const validated = validateRequest(REQUEST)
    const result = normalizeDecisionResult(
      { selected: 'x', usage: { metrics: { decisions: 3, bad: Number.POSITIVE_INFINITY } } },
      { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
    )
    assert.deepEqual(result.usage?.metrics, { decisions: 3 })
  })

  it('reaches telemetry, so an integrator needs no private statistics', async () => {
    const records: { inputTokens?: number }[] = []
    const registry = new DecisionProviderRegistry()
    registry.register(new ScriptedProvider({
      id: 'p',
      plan: (request) => {
        const selected = request.candidates[0]?.id
        return Promise.resolve({
          provider: 'p',
          mode: 'choice',
          ...selected === undefined ? {} : { selected },
          usage: { inputTokens: 42 },
          latencyMs: 0,
        })
      },
    }), { enabled: true })
    const engine = new DecisionEngine({ defaultProviderId: 'p', telemetry: record => records.push(record) }, registry)
    await engine.decide(REQUEST)
    assert.equal(records.at(-1)?.inputTokens, 42)
  })

  it('the Laya provider reports SDK input tokens through the result', async () => {
    const { LayaDecisionProvider } = await import('../../src/providers/laya/provider.ts')
    const { QUESTION_KEYS } = await import('../../src/providers/laya/modes.ts')
    const provider = new LayaDecisionProvider({
      instance: {
        systemOne: () => Promise.resolve({
          answers: { [QUESTION_KEYS.select]: { type: 'choice', choice: 'x', probabilities: { x: 0.6, y: 0.4 }, confidence: 0.2 } },
          usage: { input_tokens: 225, output_tokens: 1 },
        }),
        close: () => Promise.resolve(),
      },
    })
    const result = await provider.decide(REQUEST)
    assert.equal(result.usage?.inputTokens, 225)
  })
})

describe('a shared environment adapter does not fail valid decisions', () => {
  /** An environment whose state advances on every observation. */
  function makeAdapter(options: { delayMs?: number } = {}) {
    let counter = 0
    const executed: string[] = []
    const adapter = new CustomEnvironmentAdapter({
      id: 'shared',
      observe: () => ({ n: (counter += 1) }),
      candidates: state => [{ id: `go-${state.n}`, description: `Go to ${state.n}`, action: { to: state.n } }],
      execute: (candidate) => {
        executed.push(String(candidate.action?.to))
        return { ok: true, message: `went to ${String(candidate.action?.to)}` }
      },
    })
    const decide = (request: DecisionRequest): Promise<DecisionResult> => new Promise((resolve) => {
      const selected = request.candidates[0]?.id
      const answer: DecisionResult = {
        provider: 'stub',
        mode: 'choice',
        ...selected === undefined ? {} : { selected },
        latencyMs: 0,
      }
      if (options.delayMs === undefined) resolve(answer)
      else setTimeout(() => resolve(answer), options.delayMs)
    })
    return { adapter, decide, executed }
  }

  it('maps and executes interleaved request/decision pairs', async () => {
    const { adapter, decide, executed } = makeAdapter()
    const observationA = await adapter.observe()
    const requestA = adapter.buildDecisionRequest(observationA, { description: 'x' })
    // A second caller observes before the first decision maps.
    const observationB = await adapter.observe()
    const requestB = adapter.buildDecisionRequest(observationB, { description: 'x' })

    const resultA = await decide(requestA)
    const resultB = await decide(requestB)
    const actionA = adapter.mapDecision(resultA, observationA)
    const actionB = adapter.mapDecision(resultB, observationB)
    assert.equal(actionA.candidateId, resultA.selected)
    assert.equal(actionB.candidateId, resultB.selected)
    assert.equal((await adapter.execute(actionA)).ok, true)
    assert.equal((await adapter.execute(actionB)).ok, true)
    assert.deepEqual(executed, ['1', '2'])
  })

  it('runs concurrent whole decisions on one adapter safely', async () => {
    const { adapter, decide, executed } = makeAdapter({ delayMs: 5 })
    const [a, b] = await Promise.all([
      adapter.decision(decide, { description: 'x' }),
      adapter.decision(decide, { description: 'x' }),
    ])
    assert.notEqual(a.result.selected, b.result.selected, 'each decision has its own candidate')
    assert.equal((await adapter.execute(a.action)).ok, true)
    assert.equal((await adapter.execute(b.action)).ok, true)
    assert.deepEqual(executed, ['1', '2'])
  })

  it('atomically executes exactly the candidate the decision named', async () => {
    // The action carries its own candidate, so a later observation cannot make
    // it execute something else — which is what a payload-by-id lookup would do.
    const { adapter, decide } = makeAdapter()
    const { action } = await adapter.decision(decide, { description: 'x' })
    // A third observation arrives before the action executes.
    await adapter.observe()
    const result = await adapter.execute(action)
    assert.equal(result.ok, true)
    assert.match(String(result.message), /went to 1/, 'the action must execute the candidate it was mapped from')
  })

  it('still refuses an id the environment never offered', async () => {
    const { adapter } = makeAdapter()
    const observation = await adapter.observe()
    adapter.buildDecisionRequest(observation, { description: 'x' })
    assert.throws(
      () => adapter.mapDecision({ provider: 'p', mode: 'choice', selected: 'never-offered', latencyMs: 0 }, observation),
      (error: unknown) => error instanceof DecisionError && error.code === 'unknown_candidate',
    )
  })

  it('bounds how much candidate history it keeps', async () => {
    const { adapter, decide } = makeAdapter()
    const first = await adapter.decision(decide, { description: 'x' })
    // Push far past the history bound, then execute the original action: the
    // per-action snapshot is what keeps this working, not the history.
    for (let index = 0; index < 40; index += 1) await adapter.observe()
    const result = await adapter.execute(first.action)
    assert.equal(result.ok, true)
  })
})

describe('the spec document matches the shipped surface', () => {
  it('the embed entry exports what the spec tells integrators to use', async () => {
    const embed = await import('../../src/embed.ts')
    for (const name of ['createDecisionLayer', 'CustomEnvironmentAdapter']) {
      assert.equal(typeof (embed as Record<string, unknown>)[name], 'function', `embed must export ${name}`)
    }
  })

  it('the custom adapter exposes the documented convenience entry', async () => {
    const { adapter, decide } = (() => {
      let counter = 0
      const adapter = new CustomEnvironmentAdapter({
        id: 'e',
        observe: () => ({ n: (counter += 1) }),
        candidates: state => [{ id: `go-${state.n}`, description: 'go', action: {} }],
        execute: () => ({ ok: true }),
      })
      return {
        adapter,
        decide: (request: DecisionRequest): Promise<DecisionResult> => {
          const selected = request.candidates[0]?.id
          return Promise.resolve({ provider: 'p', mode: 'choice', ...selected === undefined ? {} : { selected }, latencyMs: 0 })
        },
      }
    })()
    const outcome = await adapter.decision(decide, { description: 'x' })
    assert.equal(outcome.result.selected, 'go-1')
    assert.equal(outcome.action.candidateId, 'go-1')
  })
})
