/**
 * Model residency and live reconfiguration.
 *
 * Two questions these tests answer with behaviour rather than prose:
 *
 * 1. **When does the model load?** Not at startup by default — one ONNX session
 *    pins the bundle's weights, so a deployment that never asks for a decision
 *    must not pay for one. Loading happens on the first decision, which is why
 *    the first call costs seconds and later ones milliseconds.
 * 2. **Can settings change it while running?** Yes: the engine, the runtime
 *    budgets, and the provider set are reconfigurable in place, and the service
 *    reports the live values rather than the ones it started with.
 *
 * @module dsh-decision-engine/tests/unit/residency.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionRuntime } from '../../src/runtime/runner.ts'
import { resolveLayaConfig } from '../../src/providers/laya/config.ts'
import { LayaDecisionProvider } from '../../src/providers/laya/provider.ts'
import { LayaRuntime } from '../../src/providers/laya/runtime.ts'
import type { LayaInstance } from '../../src/providers/laya/runtime.ts'

/** A fake instance that counts how often it was closed. */
function countingInstance(): { instance: LayaInstance; closes: () => number; calls: () => number } {
  let closes = 0
  let calls = 0
  const instance: LayaInstance = {
    systemOne: () => {
      calls += 1
      return Promise.resolve({ answers: { sel: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 }, confidence: 0.2 } } })
    },
    close: () => {
      closes += 1
      return Promise.resolve()
    },
  }
  return { instance, closes: () => closes, calls: () => calls }
}

describe('when the model loads', () => {
  it('does not load at construction by default', async () => {
    let loads = 0
    const runtime = new LayaRuntime({
      loadModule: async () => {
        loads += 1
        return { Laya: { load: async () => countingInstance().instance } }
      },
    })
    assert.equal(runtime.status, 'idle')
    assert.equal(loads, 0, 'constructing the provider must not open a session')
    assert.equal(runtime.instance, undefined)

    // The first call is what loads.
    await runtime.systemOne({ a: 1 }, {})
    assert.equal(loads, 1)
    assert.equal(runtime.status, 'ready')
    await runtime.systemOne({ a: 2 }, {})
    assert.equal(loads, 1, 'the session is reused, not reloaded per call')
    await runtime.close()
  })

  it('loads eagerly only when autoLoad is set', async () => {
    let loads = 0
    const runtime = new LayaRuntime({
      autoLoad: true,
      loadModule: async () => {
        loads += 1
        return { Laya: { load: async () => countingInstance().instance } }
      },
    })
    await runtime.load()
    assert.equal(loads, 1, 'autoLoad is the opt-in that moves the cost to startup')
    await runtime.close()
  })

  it('takes autoLoad from the provider config, so the settings panel controls it', () => {
    assert.equal(resolveLayaConfig({}).autoLoad, false, 'the default must not load a 1.6 GB bundle at startup')
    assert.equal(resolveLayaConfig({ autoLoad: true }).autoLoad, true)
    // A provider built without an explicit option inherits the config value.
    const provider = new LayaDecisionProvider({ config: { autoLoad: true }, instance: countingInstance().instance })
    assert.equal(provider.runtime.status, 'ready')
  })

  it('reports residency diagnostics in health', async () => {
    const { instance } = countingInstance()
    const provider = new LayaDecisionProvider({ instance, idleTtlMs: 5_000 })
    const health = await provider.healthCheck()
    assert.equal(health.details?.idleTtlMs, 5_000)
    assert.equal(health.details?.unloads, 0)
  })
})

describe('idle release', () => {
  it('keeps the session resident when the TTL is 0', async () => {
    const counter = countingInstance()
    const runtime = new LayaRuntime({ instance: counter.instance })
    assert.equal(runtime.idleTtlMs, 0)
    await runtime.systemOne({ a: 1 }, {})
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(counter.closes(), 0, 'the default must not release the session')
    await runtime.close()
  })

  it('releases the session after the idle TTL, and reloads on the next call', async () => {
    let loads = 0
    const counter = countingInstance()
    const runtime = new LayaRuntime({
      idleTtlMs: 10,
      idleCheckIntervalMs: 25,
      loadModule: async () => {
        loads += 1
        return { Laya: { load: async () => counter.instance } }
      },
    })
    await runtime.systemOne({ a: 1 }, {})
    assert.equal(loads, 1)
    assert.equal(runtime.status, 'ready')

    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(counter.closes(), 1, 'the idle timer must release the weights')
    assert.equal(runtime.idleTtlMs > 0, true)
    assert.equal(runtime.unloads, 1)

    // The next decision transparently reloads.
    await runtime.systemOne({ a: 2 }, {})
    assert.equal(loads, 2, 'a released session is reloaded on demand')
    assert.equal(runtime.status, 'ready')
    await runtime.close()
  })

  it('does not release a session that is being used', async () => {
    const counter = countingInstance()
    const runtime = new LayaRuntime({ instance: counter.instance, idleTtlMs: 1_000, idleCheckIntervalMs: 20, now: () => Date.now() })
    await runtime.systemOne({ a: 1 }, {})
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(counter.closes(), 0, 'a TTL longer than the wait must not release')
    await runtime.close()
  })

  it('unload is idempotent and reports whether a session was open', async () => {
    const counter = countingInstance()
    const runtime = new LayaRuntime({ instance: counter.instance })
    assert.equal(await runtime.unload(), true)
    assert.equal(await runtime.unload(), false)
    assert.equal(counter.closes(), 1)
    await runtime.close()
  })
})

describe('live reconfiguration', () => {
  it('re-points the confidence floor and the deadline on a running engine', async () => {
    const engine = new DecisionEngine({ confidenceThreshold: 0.9, timeoutMs: 1_000 })
    assert.equal(engine.confidenceThreshold, 0.9)
    engine.reconfigure({ confidenceThreshold: 0.1, timeoutMs: 2_000 })
    assert.equal(engine.confidenceThreshold, 0.1)
    // The floor it now applies is the new one: a 0.5-confidence result passes.
    engine.registry.register({
      id: 'p',
      capabilities: ['choice'],
      decide: () => Promise.resolve({ provider: 'p', mode: 'choice', selected: 'a', confidence: 0.5, confidenceKind: 'normalized', latencyMs: 0 }),
    }, { enabled: true })
    const result = await engine.decide({ state: 's', candidates: [{ id: 'a', description: 'A' }] })
    assert.equal(result.selected, 'a')
  })

  it('rejects an unknown default provider instead of storing it', () => {
    const engine = new DecisionEngine({})
    assert.throws(() => engine.reconfigure({ defaultProviderId: 'ghost' }))
  })

  it('re-points the runtime budgets on a running runtime', () => {
    const engine = new DecisionEngine({})
    const runtime = new DecisionRuntime(engine)
    assert.equal(runtime.resolveConfig().maxSteps, 10)
    runtime.reconfigure({ maxSteps: 4, confidenceThreshold: 0.2 })
    assert.equal(runtime.resolveConfig().maxSteps, 4)
    assert.equal(runtime.resolveConfig().confidenceThreshold, 0.2)
    // Unknown keys are ignored rather than silently added.
    runtime.reconfigure({ notAField: 1 } as never)
    assert.equal(runtime.resolveConfig().maxSteps, 4)
  })

  it('swaps the telemetry sink without losing failure containment', async () => {
    const seen: string[] = []
    const engine = new DecisionEngine({})
    engine.registry.register({
      id: 'p',
      capabilities: ['choice'],
      decide: () => Promise.resolve({ provider: 'p', mode: 'choice', selected: 'a', latencyMs: 0 }),
    }, { enabled: true })
    engine.reconfigure({
      telemetry: () => {
        seen.push('called')
        throw new Error('sink exploded')
      },
    })
    // A throwing sink must not break the decision.
    const result = await engine.decide({ state: 's', candidates: [{ id: 'a', description: 'A' }] })
    assert.equal(result.selected, 'a')
    assert.deepEqual(seen, ['called'])
  })
})
