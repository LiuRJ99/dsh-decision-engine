/**
 * A. Core unit tests — provider registration, routing, validation,
 * normalization, gating, and failure paths.
 *
 * @module dsh-decision-engine/tests/unit/core.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionError } from '../../src/core/errors.ts'
import { DecisionProviderRegistry } from '../../src/core/provider-registry.ts'
import { normalizeDecisionResult, rankByScore, validateRequest } from '../../src/core/validate.ts'
import { createRingBufferSink } from '../../src/core/telemetry.ts'
import type { DecisionProvider, DecisionRequest } from '../../src/core/types.ts'
import { constantProvider, hangingProvider, rankingProvider, ScriptedProvider, throwingProvider, unhealthyProvider } from '../helpers.ts'

const REQUEST: DecisionRequest = {
  objective: 'Choose the next step',
  state: 'The form is filled in and the submit button is enabled.',
  candidates: [
    { id: 'submit', description: 'Submit the form' },
    { id: 'edit', description: 'Keep editing' },
    { id: 'wait', description: 'Wait for the page' },
  ],
}

describe('provider registration', () => {
  it('registers a provider and makes it the default', () => {
    const registry = new DecisionProviderRegistry()
    const dispose = registry.register(constantProvider('submit'))
    assert.deepEqual(registry.ids(), ['scripted'])
    assert.equal(registry.getDefaultId(), 'scripted')
    assert.equal(registry.get('scripted')?.id, 'scripted')
    dispose()
    assert.deepEqual(registry.ids(), [])
    assert.equal(registry.getDefaultId(), undefined)
  })

  it('rejects a duplicate id unless replace is set', () => {
    const registry = new DecisionProviderRegistry()
    registry.register(constantProvider('a', { id: 'dup' }))
    assert.throws(() => registry.register(constantProvider('b', { id: 'dup' })), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'invalid_request'
    })
    registry.register(constantProvider('b', { id: 'dup' }), { replace: true })
    assert.equal(registry.ids().length, 1)
  })

  it('rejects a provider with no capabilities and an unknown capability', () => {
    const registry = new DecisionProviderRegistry()
    assert.throws(
      () => registry.register({ id: 'empty', capabilities: [], decide: () => Promise.reject(new Error('unused')) }),
      (error: unknown) => error instanceof DecisionError && error.code === 'invalid_request',
    )
    assert.throws(
      () => registry.register({ id: 'weird', capabilities: ['noul' as never], decide: () => Promise.reject(new Error('unused')) }),
      (error: unknown) => error instanceof DecisionError && error.code === 'invalid_request',
    )
  })

  it('keeps a disabled provider registered but unroutable', () => {
    const registry = new DecisionProviderRegistry()
    registry.register(constantProvider('submit', { id: 'off' }), { enabled: false })
    assert.ok(registry.has('off'))
    assert.deepEqual(registry.enabledIds(), [])
    assert.equal(registry.getDefaultId(), undefined)
    assert.throws(() => registry.require('off'), (error: unknown) => error instanceof DecisionError && error.code === 'provider_unavailable')
  })

  it('falls back to the next enabled provider when the default is unregistered', () => {
    const registry = new DecisionProviderRegistry()
    registry.register(constantProvider('a', { id: 'first' }))
    const dispose = registry.register(constantProvider('b', { id: 'second' }))
    registry.setDefault('second')
    assert.equal(registry.getDefaultId(), 'second')
    dispose()
    assert.equal(registry.getDefaultId(), 'first')
  })

  it('reports capability coverage per provider', () => {
    const registry = new DecisionProviderRegistry()
    registry.register(new ScriptedProvider({ id: 'chooser', capabilities: ['choice'], plan: () => ({ provider: 'chooser', mode: 'choice', selected: 'a', latencyMs: 0 }) }))
    registry.register(rankingProvider(['a'], { id: 'ranker' }))
    assert.deepEqual(registry.idsWithCapability('choice').sort(), ['chooser', 'ranker'])
    assert.deepEqual(registry.idsWithCapability('ranking'), ['ranker'])
    assert.deepEqual(registry.idsWithCapability('score'), ['ranker'])
  })

  it('lists descriptors including enabled, capabilities, health, and default', () => {
    const registry = new DecisionProviderRegistry()
    registry.register(constantProvider('a', { id: 'one' }))
    registry.register(unhealthyProvider({ status: 'degraded' }, 'two'), { enabled: false })
    assert.deepEqual(registry.list(), [
      { id: 'one', enabled: true, capabilities: ['choice', 'ranking', 'score', 'classification'], hasHealthCheck: false, isDefault: true },
      { id: 'two', enabled: false, capabilities: ['choice'], hasHealthCheck: true, isDefault: false },
    ])
  })
})

describe('engine routing', () => {
  it('routes to the default provider', async () => {
    const engine = new DecisionEngine({}, registryWith([constantProvider('submit', { id: 'laya-like' })]))
    const result = await engine.decide(REQUEST)
    assert.equal(result.provider, 'laya-like')
    assert.equal(result.selected, 'submit')
  })

  it('honours an explicit provider on the request', async () => {
    const registry = registryWith([
      constantProvider('submit', { id: 'first' }),
      constantProvider('wait', { id: 'second' }),
    ])
    const engine = new DecisionEngine({ defaultProviderId: 'first' }, registry)
    const result = await engine.decide({ ...REQUEST, provider: 'second' })
    assert.equal(result.provider, 'second')
    assert.equal(result.selected, 'wait')
  })

  it('honours an explicit provider in the call options, overriding the request', async () => {
    const registry = registryWith([
      constantProvider('submit', { id: 'first' }),
      constantProvider('wait', { id: 'second' }),
    ])
    const engine = new DecisionEngine({ defaultProviderId: 'first' }, registry)
    const result = await engine.decide({ ...REQUEST, provider: 'first' }, { provider: 'second' })
    assert.equal(result.provider, 'second')
  })

  it('fails with provider_unknown for an unregistered provider', async () => {
    const engine = new DecisionEngine({}, registryWith([constantProvider('submit')]))
    await assert.rejects(engine.decide({ ...REQUEST, provider: 'nope' }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_unknown'
    })
  })

  it('falls back to a capable provider when the default lacks the mode', async () => {
    const registry = new DecisionProviderRegistry()
    registry.register(new ScriptedProvider({ id: 'chooser', capabilities: ['choice'], plan: () => ({ provider: 'chooser', mode: 'choice', selected: 'submit', latencyMs: 0 }) }))
    registry.register(rankingProvider(['submit', 'edit'], { id: 'ranker' }))
    const engine = new DecisionEngine({ defaultProviderId: 'chooser' }, registry)
    const result = await engine.decide({ ...REQUEST, mode: 'ranking' })
    assert.equal(result.provider, 'ranker')
    assert.deepEqual(result.ranking?.map(entry => entry.id), ['submit', 'edit'])
  })

  it('refuses an unsupported mode when fallback is disabled', async () => {
    const registry = registryWith([new ScriptedProvider({ id: 'chooser', capabilities: ['choice'], plan: () => ({ provider: 'chooser', mode: 'choice', selected: 'submit', latencyMs: 0 }) })])
    const engine = new DecisionEngine({ defaultProviderId: 'chooser', allowCapabilityFallback: false }, registry)
    await assert.rejects(engine.decide({ ...REQUEST, mode: 'ranking' }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_unsupported_capability'
    })
  })

  it('fails with provider_unavailable when nothing is enabled', async () => {
    const engine = new DecisionEngine({}, new DecisionProviderRegistry())
    await assert.rejects(engine.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_unavailable'
    })
  })
})

describe('capability validation', () => {
  it('refuses a request whose mode the pinned provider cannot run', async () => {
    const registry = registryWith([new ScriptedProvider({ id: 'chooser', capabilities: ['choice'], plan: () => ({ provider: 'chooser', mode: 'choice', selected: 'submit', latencyMs: 0 }) })])
    const engine = new DecisionEngine({ defaultProviderId: 'chooser', allowCapabilityFallback: false }, registry)
    await assert.rejects(engine.decide({ ...REQUEST, mode: 'classification' }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_unsupported_capability'
    })
  })

  it('never exposes a noul capability', async () => {
    const registry = new DecisionProviderRegistry()
    for (const capability of ['choice', 'ranking', 'score', 'classification'] as const) {
      assert.ok(capability.length > 0)
    }
    assert.throws(() => registry.register({ id: 'noul-provider', capabilities: ['noul' as never], decide: () => Promise.reject(new Error('unused')) }))
  })
})

describe('request validation', () => {
  it('rejects an empty candidate set with no_candidates', () => {
    assert.throws(() => validateRequest({ state: 'x', candidates: [] }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'no_candidates'
    })
  })

  it('rejects duplicate candidate ids', () => {
    assert.throws(
      () => validateRequest({ state: 'x', candidates: [{ id: 'a', description: 'A' }, { id: 'a', description: 'A again' }] }),
      (error: unknown) => error instanceof DecisionError && error.code === 'invalid_request',
    )
  })

  it('rejects a missing description, a non-array candidates value, and an unknown mode', () => {
    assert.throws(() => validateRequest({ state: 'x', candidates: [{ id: 'a', description: '' }] }))
    assert.throws(() => validateRequest({ state: 'x', candidates: 'nope' as never }))
    assert.throws(() => validateRequest({ state: 'x', candidates: [{ id: 'a', description: 'A' }], mode: 'vibes' as never }))
  })

  it('accepts object state and defaults the mode to choice', () => {
    const validated = validateRequest({ state: { hp: 3 }, candidates: [{ id: 'a', description: 'A' }] })
    assert.equal(validated.mode, 'choice')
    assert.equal(validated.byId.size, 1)
  })

  it('caps the candidate count', () => {
    const candidates = Array.from({ length: 65 }, (_value, index) => ({ id: `c${index}`, description: `c${index}` }))
    assert.throws(() => validateRequest({ state: 'x', candidates }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'invalid_request'
    })
  })
})

describe('decision normalization', () => {
  const validated = validateRequest(REQUEST)

  it('rejects a selected id outside the candidate set', () => {
    assert.throws(
      () => normalizeDecisionResult({ selected: 'launch-missiles' }, { providerId: 'p', mode: 'choice', validated, latencyMs: 1 }),
      (error: unknown) => error instanceof DecisionError && error.code === 'unknown_candidate',
    )
  })

  it('drops unknown ranking entries instead of failing the call', () => {
    const result = normalizeDecisionResult(
      { ranking: [{ id: 'submit', score: 2 }, { id: 'ghost', score: 9 }, { id: 'wait', score: 1 }] },
      { providerId: 'p', mode: 'ranking', validated, latencyMs: 3 },
    )
    assert.deepEqual(result.ranking, [{ id: 'submit', score: 2 }, { id: 'wait', score: 1 }])
    assert.equal(result.selected, 'submit')
  })

  it('derives selected from a ranking and a ranking from a selection', () => {
    const fromRanking = normalizeDecisionResult({ ranking: [{ id: 'edit', score: 5 }] }, { providerId: 'p', mode: 'ranking', validated, latencyMs: 1 })
    assert.equal(fromRanking.selected, 'edit')
    const fromSelection = normalizeDecisionResult({ selected: 'wait' }, { providerId: 'p', mode: 'choice', validated, latencyMs: 1 })
    assert.deepEqual(fromSelection.ranking, [{ id: 'wait' }])
  })

  it('rejects a result with neither selection nor ranking', () => {
    assert.throws(
      () => normalizeDecisionResult({}, { providerId: 'p', mode: 'choice', validated, latencyMs: 1 }),
      (error: unknown) => error instanceof DecisionError && error.code === 'invalid_decision',
    )
  })

  it('rejects an out-of-range confidence rather than clamping a lie', () => {
    assert.throws(
      () => normalizeDecisionResult(
        { selected: 'submit', confidence: 7, confidenceKind: 'normalized' },
        { providerId: 'p', mode: 'choice', validated, latencyMs: 1 },
      ),
      (error: unknown) => error instanceof DecisionError && /outside 0\.\.1/.test(error.message),
    )
  })

  it('rejects a confidence with no kind (the scale must be declared)', () => {
    assert.throws(
      () => normalizeDecisionResult({ selected: 'submit', confidence: 0.5 }, { providerId: 'p', mode: 'choice', validated, latencyMs: 1 }),
      (error: unknown) => error instanceof DecisionError && /without a confidenceKind/.test(error.message),
    )
  })

  it('keeps debug detail only when it was requested', () => {
    const withDebug = normalizeDecisionResult({ selected: 'submit', debug: { raw: { p: 1 } } }, { providerId: 'p', mode: 'choice', validated, latencyMs: 1, includeDebug: true })
    assert.deepEqual(withDebug.debug, { raw: { p: 1 } })
    const withoutDebug = normalizeDecisionResult({ selected: 'submit', debug: { raw: { p: 1 } } }, { providerId: 'p', mode: 'choice', validated, latencyMs: 1 })
    assert.equal(withoutDebug.debug, undefined)
  })

  it('rejects a non-object decision', () => {
    assert.throws(() => normalizeDecisionResult('submit', { providerId: 'p', mode: 'choice', validated, latencyMs: 1 }))
  })

  it('ranks by descending score with stable ties', () => {
    assert.deepEqual(rankByScore([{ id: 'a', score: 1 }, { id: 'b', score: 3 }, { id: 'c', score: 1 }]), [
      { id: 'b', score: 3 },
      { id: 'a', score: 1 },
      { id: 'c', score: 1 },
    ])
    assert.deepEqual(rankByScore([{ id: 'a' }, { id: 'b' }]), [{ id: 'a' }, { id: 'b' }])
  })
})

describe('confidence threshold', () => {
  it('rejects a choice below the floor', async () => {
    const engine = new DecisionEngine({ confidenceThreshold: 0.6 }, registryWith([constantProvider('submit', { confidence: 0.2, confidenceKind: 'normalized' })]))
    await assert.rejects(engine.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'low_confidence'
    })
  })

  it('accepts a choice above the floor', async () => {
    const engine = new DecisionEngine({ confidenceThreshold: 0.6 }, registryWith([constantProvider('submit', { confidence: 0.9, confidenceKind: 'normalized' })]))
    const result = await engine.decide(REQUEST)
    assert.equal(result.selected, 'submit')
  })

  it('does not apply the floor to ranking and score', async () => {
    const engine = new DecisionEngine({ confidenceThreshold: 0.9 }, registryWith([rankingProvider(['submit', 'wait'], { confidence: 0.1 })]))
    const result = await engine.decide({ ...REQUEST, mode: 'ranking' })
    assert.equal(result.selected, 'submit')
  })

  it('allows a per-call override of the floor', async () => {
    const engine = new DecisionEngine({ confidenceThreshold: 0.9 }, registryWith([constantProvider('submit', { confidence: 0.2, confidenceKind: 'normalized' })]))
    const result = await engine.decide(REQUEST, { confidenceThreshold: 0 })
    assert.equal(result.selected, 'submit')
  })
})

describe('provider failure paths', () => {
  it('maps a hanging provider to provider_timeout', async () => {
    const engine = new DecisionEngine({ timeoutMs: 25 }, registryWith([hangingProvider()]))
    await assert.rejects(engine.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_timeout'
    })
  })

  it('maps a thrown non-DecisionError to provider_failed', async () => {
    const engine = new DecisionEngine({}, registryWith([throwingProvider('model exploded')]))
    await assert.rejects(engine.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_failed' && /model exploded/.test(error.message)
    })
  })

  it('propagates a DecisionError from the provider unchanged', async () => {
    const provider = new ScriptedProvider({
      id: 'angry',
      plan: () => {
        throw new DecisionError('provider_unavailable', 'the model is not loaded')
      },
    })
    const engine = new DecisionEngine({}, registryWith([provider]))
    await assert.rejects(engine.decide(REQUEST), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'provider_unavailable'
    })
  })

  it('reports health for every provider, containing a throwing check', async () => {
    const registry = new DecisionProviderRegistry()
    registry.register(unhealthyProvider({ status: 'degraded', reason: 'still loading' }, 'slow'))
    registry.register({
      id: 'broken',
      capabilities: ['choice'],
      decide: () => Promise.reject(new Error('unused')),
      healthCheck: () => {
        throw new Error('health probe crashed')
      },
    })
    registry.register(constantProvider('a', { id: 'fine' }))
    const health = await registry.health()
    assert.equal(health.slow?.status, 'degraded')
    assert.equal(health.broken?.status, 'unavailable')
    assert.match(health.broken?.reason ?? '', /health probe crashed/)
    assert.equal(health.fine?.status, 'ok')
  })
})

describe('telemetry', () => {
  it('emits one record per decision with counts and timings, and never payloads', async () => {
    const { sink, records } = createRingBufferSink(10)
    const engine = new DecisionEngine({ telemetry: sink }, registryWith([constantProvider('submit', { confidence: 0.7, confidenceKind: 'normalized' })]))
    await engine.decide({ ...REQUEST, state: 'SECRET-PAGE-TEXT' })
    assert.equal(records.length, 1)
    const record = records[0]
    assert.equal(record?.kind, 'decision')
    assert.equal(record?.provider, 'scripted')
    assert.equal(record?.selected, 'submit')
    assert.equal(record?.confidence, 0.7)
    assert.equal(record?.confidenceKind, 'normalized', 'the record must say which scale the number is on')
    assert.equal(record?.candidateCount, 3)
    assert.ok((record?.timings.totalMs ?? -1) >= 0)
    assert.ok(!JSON.stringify(records).includes('SECRET-PAGE-TEXT'), 'telemetry must not carry state payloads')
  })

  it('emits an escalation record with the failure code', async () => {
    const { sink, records } = createRingBufferSink(10)
    const engine = new DecisionEngine({ telemetry: sink }, registryWith([throwingProvider('nope')]))
    await assert.rejects(engine.decide(REQUEST))
    assert.equal(records.at(-1)?.escalationReason, 'provider_failed')
  })

  it('bounds the ring buffer', async () => {
    const { sink, records } = createRingBufferSink(3)
    const engine = new DecisionEngine({ telemetry: sink }, registryWith([constantProvider('submit')]))
    for (let index = 0; index < 6; index += 1) await engine.decide(REQUEST)
    assert.equal(records.length, 3)
  })

  it('contains a telemetry sink that throws', async () => {
    const engine = new DecisionEngine({
      telemetry: () => {
        throw new Error('sink is broken')
      },
    }, registryWith([constantProvider('submit')]))
    const result = await engine.decide(REQUEST)
    assert.equal(result.selected, 'submit')
  })
})

function registryWith(providers: DecisionProvider[]): DecisionProviderRegistry {
  const registry = new DecisionProviderRegistry()
  for (const provider of providers) registry.register(provider)
  return registry
}
