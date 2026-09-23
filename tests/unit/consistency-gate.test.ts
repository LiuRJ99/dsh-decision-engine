/**
 * The consistency gate: a composite provider that refuses an answer which changes
 * when the candidates are reordered.
 *
 * The fake providers below are the two behaviours the gate exists to tell apart:
 *
 * - `contentProvider` answers by **content** — the same option id whatever the order;
 * - `positionProvider` answers by **slot** — whatever sits first, which is what a
 *   small model with a first-slot prior does (measured on the real Laya bundle:
 *   same state, same four options, order reversed → winner flipped, every score
 *   stayed sorted by slot, top-1 moved 0.551 → 0.295).
 *
 * @module dsh-decision-engine/tests/unit/consistency-gate.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { ConsistencyGatedProvider } from '../../src/providers/consistency-gate.ts'
import { isDecisionError } from '../../src/core/errors.ts'
import type {
  DecisionCapability,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  ProviderHealth,
} from '../../src/core/types.ts'

const CANDIDATES = [
  { id: 'alpha', description: 'first option' },
  { id: 'beta', description: 'second option' },
  { id: 'gamma', description: 'third option' },
  { id: 'delta', description: 'fourth option' },
]

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return { objective: 'pick one', state: 'state text', candidates: CANDIDATES, mode: 'choice', ...overrides }
}

/** A provider that behaves however the test needs; records every call. */
class FakeProvider implements DecisionProvider {
  readonly id: string
  readonly capabilities: readonly DecisionCapability[]
  readonly calls: DecisionRequest[] = []
  readonly #behaviour: (req: DecisionRequest, callIndex: number) => DecisionResult

  constructor(id: string, behaviour: (req: DecisionRequest, callIndex: number) => DecisionResult, capabilities: readonly DecisionCapability[] = ['choice']) {
    this.id = id
    this.capabilities = capabilities
    this.#behaviour = behaviour
  }

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const index = this.calls.length
    this.calls.push(req)
    return this.#behaviour(req, index)
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { status: 'ok' }
  }
}

/** Answers by content: always the same id, regardless of where it sits. */
function contentProvider(id = 'content', pinned = 'gamma'): FakeProvider {
  return new FakeProvider(id, (req) => {
    assert.ok(req.candidates.some((c) => c.id === pinned), 'the fake provider only answers options that exist')
    return { provider: id, mode: 'choice', selected: pinned, ranking: [{ id: pinned, score: 0.6 }], confidence: 0.6, confidenceKind: 'provider_raw', latencyMs: 1 }
  })
}

/** Answers by position: whatever is listed first — the behaviour the gate must catch. */
function positionProvider(id = 'position'): FakeProvider {
  return new FakeProvider(id, (req) => {
    const first = req.candidates[0]
    assert.ok(first !== undefined)
    return { provider: id, mode: 'choice', selected: first.id, ranking: [{ id: first.id, score: 0.5 }], confidence: 0.5, confidenceKind: 'provider_raw', latencyMs: 1 }
  })
}

describe('consistency gate: telling content from position', () => {
  it('passes an order-invariant answer straight through', async () => {
    const primary = contentProvider('content', 'gamma')
    const fallback = contentProvider('fallback', 'alpha')
    const gate = new ConsistencyGatedProvider({ primary, fallback })

    const result = await gate.decide(request())

    assert.equal(result.selected, 'gamma')
    assert.equal(result.provider, 'content', 'the answering arm is named (§3.1b)')
    assert.equal(fallback.calls.length, 0, 'the fallback is not consulted when the gate passes')
    assert.equal(primary.calls.length, 2, 'two probes: the given order, then a rotation')
    assert.deepEqual(gate.stats(), { probes: 1, agreements: 1, disagreements: 0, fallbacks: 0, primaryFailures: 0, bothFailed: 0 })
  })

  it('rejects a position-determined answer and answers from the fallback', async () => {
    const primary = positionProvider('position')
    const fallback = contentProvider('fallback', 'delta')
    const gate = new ConsistencyGatedProvider({ primary, fallback })

    const result = await gate.decide(request())

    assert.equal(result.selected, 'delta', 'the fallback answered, not the position-bound primary')
    assert.equal(result.provider, 'fallback')
    assert.equal(gate.stats().disagreements, 1)
    assert.equal(gate.stats().fallbacks, 1)
    // The probe really did reorder: the primary saw a different first candidate.
    assert.notEqual(primary.calls[0]?.candidates[0]?.id, primary.calls[1]?.candidates[0]?.id)
  })

  it('keeps the caller\'s candidate set untouched (same ids, same length)', async () => {
    const primary = positionProvider()
    const fallback = contentProvider('fallback')
    const gate = new ConsistencyGatedProvider({ primary, fallback })
    const original = request()

    await gate.decide(original)

    const ids = original.candidates.map((c) => c.id)
    assert.deepEqual(ids, ['alpha', 'beta', 'gamma', 'delta'], 'the caller\'s array was not mutated')
    for (const call of primary.calls) {
      assert.deepEqual([...call.candidates.map((c) => c.id)].sort(), [...ids].sort(), 'the probe offers the same set, only reordered')
    }
  })

  it('a rotation equal to the candidate count does not self-compare', async () => {
    // rotation 4 over 4 candidates would reproduce the original order, making any
    // position-bound provider look order-invariant. The gate must bump it to 1.
    const primary = positionProvider()
    const fallback = contentProvider('fallback', 'beta')
    const gate = new ConsistencyGatedProvider({ primary, fallback, rotation: 4 })

    const result = await gate.decide(request())

    assert.equal(result.selected, 'beta', 'the gate still caught the position-bound answer')
    assert.equal(gate.stats().disagreements, 1)
  })

  it('does not probe when there is nothing to permute', async () => {
    const primary = positionProvider()
    const fallback = contentProvider('fallback', 'only')
    const gate = new ConsistencyGatedProvider({ primary, fallback })

    const result = await gate.decide(request({ candidates: [{ id: 'only', description: 'the only option' }] }))

    assert.equal(result.selected, 'only')
    assert.equal(primary.calls.length, 1, 'a single candidate has only one ordering')
    assert.equal(gate.stats().probes, 0)
  })

  it('names the fallback when the primary throws', async () => {
    const primary = new FakeProvider('broken', () => { throw new Error('model session gone') })
    const fallback = contentProvider('fallback', 'alpha')
    const gate = new ConsistencyGatedProvider({ primary, fallback })

    const result = await gate.decide(request())

    assert.equal(result.selected, 'alpha')
    assert.equal(result.provider, 'fallback')
    assert.equal(gate.stats().primaryFailures, 1)
  })

  it('surfaces a failure when both arms fail', async () => {
    const primary = new FakeProvider('broken', () => { throw new Error('primary down') })
    const fallback = new FakeProvider('also-broken', () => { throw new Error('fallback down') })
    const gate = new ConsistencyGatedProvider({ primary, fallback })

    await assert.rejects(
      () => gate.decide(request()),
      (error: unknown) => {
        assert.ok(isDecisionError(error), 'a DecisionError, not a bare throw')
        assert.equal((error as { code?: string }).code, 'provider_failed')
        assert.match((error as Error).message, /primary down/)
        assert.match((error as Error).message, /fallback down/)
        return true
      },
    )
    assert.equal(gate.stats().bothFailed, 1)
  })
})

describe('consistency gate: spec conformance', () => {
  it('claims only the capabilities both arms implement', () => {
    const wide = new FakeProvider('wide', (req) => {
      const first = req.candidates[0]
      assert.ok(first !== undefined)
      return { provider: 'wide', mode: 'choice', selected: first.id, latencyMs: 1 }
    }, ['choice', 'score', 'ranking'])
    const narrow: DecisionProvider = {
      id: 'narrow',
      capabilities: ['choice', 'score'],
      decide: async (req) => {
        const first = req.candidates[0]
        assert.ok(first !== undefined)
        return { provider: 'narrow', mode: 'choice', selected: first.id, latencyMs: 1 }
      },
    }
    const gate = new ConsistencyGatedProvider({ primary: wide, fallback: narrow })

    assert.deepEqual([...gate.capabilities], ['choice', 'score'], 'the intersection, in canonical order')
  })

  it('passes confidence through untouched instead of inventing one', async () => {
    const primary = contentProvider('content', 'gamma')
    const fallback = contentProvider('fallback', 'alpha')
    const gate = new ConsistencyGatedProvider({ primary, fallback })

    const result = await gate.decide(request())

    assert.equal(result.confidence, 0.6)
    assert.equal(result.confidenceKind, 'provider_raw', 'a raw scale is never relabelled as normalized (§1.3)')
  })

  it('reports the total time it spent, not just one probe', async () => {
    let clock = 0
    const slow = new FakeProvider('slow', () => {
      clock += 25
      return { provider: 'slow', mode: 'choice', selected: 'gamma', latencyMs: 25 }
    })
    const fallback = contentProvider('fallback', 'alpha')
    const gate = new ConsistencyGatedProvider({ primary: slow, fallback })
    const realNow = Date.now
    Date.now = () => {
      const value = realNow.call(Date) + clock
      return value
    }
    try {
      const result = await gate.decide(request())
      assert.ok(result.latencyMs >= 50, `expected the gate to report both probes, got ${result.latencyMs}`)
    } finally {
      Date.now = realNow
    }
  })

  it('reports degraded health when an arm is impaired', async () => {
    const primary: DecisionProvider = {
      id: 'primary',
      capabilities: ['choice'],
      decide: async () => ({ provider: 'primary', mode: 'choice', selected: 'alpha', latencyMs: 0 }),
      healthCheck: async () => ({ status: 'unavailable', reason: 'model not loaded' }),
    }
    const fallback = contentProvider('fallback', 'alpha')
    const gate = new ConsistencyGatedProvider({ primary, fallback })

    const health = await gate.healthCheck()

    assert.equal(health.status, 'degraded')
    assert.match(health.reason ?? '', /model not loaded/)
  })

  it('rejects a nonsensical composition up front', () => {
    const arm = contentProvider('same')
    assert.throws(() => new ConsistencyGatedProvider({ primary: arm, fallback: arm }), (error: unknown) => {
      assert.ok(isDecisionError(error))
      assert.equal((error as { code?: string }).code, 'invalid_request')
      return true
    })
  })
})
