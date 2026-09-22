/**
 * D. Runtime tests — the three promotion levels, every stop condition, and the
 * proof that no loop is unbounded.
 *
 * @module dsh-decision-engine/tests/unit/runtime.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionError } from '../../src/core/errors.ts'
import { DecisionProviderRegistry } from '../../src/core/provider-registry.ts'
import { EnvironmentRegistry } from '../../src/environments/registry.ts'
import { CustomEnvironmentAdapter } from '../../src/environments/custom/adapter.ts'
import type { EnvironmentAdapter } from '../../src/environments/types.ts'
import { DecisionRuntime, DEFAULT_RUNTIME_CONFIG, fingerprintState } from '../../src/runtime/runner.ts'
import { constantProvider, ScriptedProvider, scriptedEnvironment } from '../helpers.ts'

/** Build an engine over one scripted provider, plus a runtime with registries. */
function harness(options: {
  decided: string | string[]
  providerId?: string
  confidence?: number
  confidenceKind?: 'normalized' | 'provider_raw' | 'unavailable'
  environments?: EnvironmentAdapter[]
  runtimeConfig?: Parameters<typeof DecisionRuntime.prototype.resolveConfig>[0]
}) {
  const picks = Array.isArray(options.decided) ? [...options.decided] : undefined
  let callIndex = 0
  const provider = new ScriptedProvider({
    id: options.providerId ?? 'scripted',
    plan: () => {
      const selected = picks === undefined
        ? options.decided as string
        : picks[Math.min(callIndex, picks.length - 1)] ?? 'wait'
      callIndex += 1
      return {
        provider: options.providerId ?? 'scripted',
        mode: 'choice',
        selected,
        ...options.confidence === undefined
          ? {}
          : { confidence: options.confidence, confidenceKind: options.confidenceKind ?? 'provider_raw' },
        latencyMs: 0,
      }
    },
  })
  const registry = new DecisionProviderRegistry()
  registry.register(provider, { enabled: true, config: {} })
  const engine = new DecisionEngine({ defaultProviderId: provider.id }, registry)
  const environments = new EnvironmentRegistry()
  for (const adapter of options.environments ?? []) environments.register(adapter)
  const runtime = new DecisionRuntime(engine, {
    environments,
    ...options.runtimeConfig === undefined ? {} : { config: options.runtimeConfig },
    now: Date.now,
  })
  return { engine, registry, runtime, environments, provider }
}

describe('promotion levels', () => {
  it('decision-only maps an action but executes nothing', async () => {
    const env = scriptedEnvironment({ states: [{ count: 0 }, { count: 1 }] })
    const { runtime } = harness({ decided: 'advance', environments: [env.adapter] })
    const outcome = await runtime.run({ environment: 'scripted-env', objective: { description: 'Advance.' } })
    assert.equal(outcome.status, 'decided')
    assert.equal(outcome.action?.candidateId, 'advance')
    assert.equal(outcome.action?.kind, 'custom')
    assert.equal(outcome.execution, undefined)
    assert.deepEqual(env.executed, [], 'decision-only must not execute')
  })

  it('single-step executes exactly one action and stops', async () => {
    const env = scriptedEnvironment({ states: [{ count: 0 }, { count: 1 }, { count: 2 }, { count: 3 }] })
    const { runtime } = harness({ decided: 'advance', environments: [env.adapter] })
    const outcome = await runtime.run({ environment: 'scripted-env', objective: { description: 'Advance.' }, mode: 'single-step' })
    assert.equal(outcome.status, 'executed')
    assert.equal(outcome.steps, 1)
    assert.equal(outcome.execution?.ok, true)
    assert.deepEqual(env.executed, ['advance'])
  })

  it('bounded-loop keeps going until the objective is met', async () => {
    // `doneAt` counts observations, and the loop observes once before deciding
    // and reuses each post-action observation, so three actions precede the fourth
    // observation satisfies the predicate.
    const env = scriptedEnvironment({ states: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }], doneAt: 4 })
    const { runtime } = harness({ decided: 'advance', environments: [env.adapter] })
    const outcome = await runtime.run({
      environment: 'scripted-env',
      objective: { description: 'Reach three.' },
      mode: 'bounded-loop',
      config: { maxSteps: 10, noProgressLimit: 10, repeatedDecisionLimit: 10 },
    })
    assert.equal(outcome.status, 'done')
    assert.equal(env.executed.length, 3)
    assert.equal(outcome.steps, 3)
  })

  it('never exceeds maxSteps and reports budget_exhausted', async () => {
    const env = scriptedEnvironment({ states: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }] })
    const { runtime } = harness({ decided: 'advance', environments: [env.adapter] })
    const outcome = await runtime.run({
      environment: 'scripted-env',
      objective: { description: 'Never reached.' },
      mode: 'bounded-loop',
      config: { maxSteps: 2, noProgressLimit: 10, repeatedDecisionLimit: 10 },
    })
    assert.equal(outcome.status, 'needs_escalation')
    assert.equal(outcome.escalation?.reason, 'budget_exhausted')
    assert.equal(env.executed.length, 2)
  })
})

describe('stop conditions', () => {
  it('escalates insufficient_observation instead of guessing', async () => {
    const adapter = new CustomEnvironmentAdapter<undefined>({
      id: 'blind',
      observe: () => undefined,
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const { runtime } = harness({ decided: 'a', environments: [adapter] })
    const outcome = await runtime.run({ environment: 'blind', objective: { description: 'Do something.' }, mode: 'bounded-loop' })
    assert.equal(outcome.escalation?.reason, 'insufficient_observation')
    assert.match(outcome.escalation?.guidance ?? '', /main agent/)
  })

  it('escalates environment_unsupported for an unusable environment', async () => {
    const adapter = new CustomEnvironmentAdapter({
      id: 'broken',
      observe: () => {
        throw new Error('device offline')
      },
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const { runtime } = harness({ decided: 'a', environments: [adapter] })
    const outcome = await runtime.run({ environment: 'broken', objective: { description: 'x' } })
    assert.equal(outcome.status, 'needs_escalation')
    assert.equal(outcome.escalation?.reason, 'environment_unavailable')
    assert.match(JSON.stringify(outcome.escalation?.details), /device offline/)
  })

  it('escalates provider_unavailable', async () => {
    const adapter = new CustomEnvironmentAdapter({
      id: 'live',
      observe: () => ({ a: 1 }),
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const registry = new DecisionProviderRegistry()
    registry.register({
      id: 'dead',
      capabilities: ['choice'],
      decide: () => Promise.reject(new DecisionError('provider_unavailable', 'model missing')),
    })
    const engine = new DecisionEngine({ defaultProviderId: 'dead' }, registry)
    const runtime = new DecisionRuntime(engine, { environments: registryEnvironment(adapter) })
    const outcome = await runtime.run({ environment: 'live', objective: { description: 'x' } })
    assert.equal(outcome.escalation?.reason, 'provider_unavailable')
  })

  it('escalates low_confidence via the engine floor', async () => {
    const adapter = new CustomEnvironmentAdapter({
      id: 'live',
      observe: () => ({ a: 1 }),
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const { runtime } = harness({
      decided: 'a',
      confidence: 0.1,
      confidenceKind: 'normalized',
      environments: [adapter],
      runtimeConfig: { confidenceThreshold: 0.9 },
    })
    const outcome = await runtime.run({ environment: 'live', objective: { description: 'x' } })
    assert.equal(outcome.escalation?.reason, 'low_confidence')
  })

  it('escalates unknown_candidate when the decision names something unmappable', async () => {
    const adapter = new CustomEnvironmentAdapter({
      id: 'live',
      observe: () => ({ a: 1 }),
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const { runtime } = harness({ decided: 'ghost', environments: [adapter] })
    const outcome = await runtime.run({ environment: 'live', objective: { description: 'x' } })
    assert.equal(outcome.status, 'needs_escalation')
    assert.ok(['unknown_candidate', 'invalid_decision'].includes(outcome.escalation?.reason ?? ''))
  })

  it('escalates action_execution_failed when the environment refuses', async () => {
    const env = scriptedEnvironment({ states: [{ n: 0 }], failExecute: 'advance' })
    const { runtime } = harness({ decided: 'advance', environments: [env.adapter] })
    const outcome = await runtime.run({ environment: 'scripted-env', objective: { description: 'x' }, mode: 'single-step' })
    assert.equal(outcome.escalation?.reason, 'action_execution_failed')
    assert.match(JSON.stringify(outcome.escalation?.details), /execution refused/)
  })

  it('escalates no_progress when the state stops changing', async () => {
    const env = scriptedEnvironment({ states: [{ frozen: true }] })
    const { runtime } = harness({ decided: ['advance', 'wait', 'advance', 'wait'], environments: [env.adapter] })
    const outcome = await runtime.run({
      environment: 'scripted-env',
      objective: { description: 'x' },
      mode: 'bounded-loop',
      config: { maxSteps: 10, noProgressLimit: 2, repeatedDecisionLimit: 10 },
    })
    assert.equal(outcome.escalation?.reason, 'no_progress')
  })

  it('escalates repeated_decision when the same candidate keeps winning', async () => {
    const env = scriptedEnvironment({ states: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] })
    const { runtime } = harness({ decided: 'advance', environments: [env.adapter] })
    const outcome = await runtime.run({
      environment: 'scripted-env',
      objective: { description: 'x' },
      mode: 'bounded-loop',
      config: { maxSteps: 10, noProgressLimit: 10, repeatedDecisionLimit: 2 },
    })
    assert.equal(outcome.escalation?.reason, 'repeated_decision')
  })

  it('escalates high_risk_action unless risky actions are allowed', async () => {
    const env = scriptedEnvironment({ states: [{ n: 0 }], risky: ['reset'] })
    const { runtime } = harness({ decided: 'reset', environments: [env.adapter] })
    const blocked = await runtime.run({ environment: 'scripted-env', objective: { description: 'x' }, mode: 'single-step' })
    assert.equal(blocked.escalation?.reason, 'high_risk_action')
    assert.deepEqual(env.executed, [])

    const env2 = scriptedEnvironment({ states: [{ n: 0 }], risky: ['reset'] })
    const second = harness({ decided: 'reset', environments: [env2.adapter] })
    const allowed = await second.runtime.run({ environment: 'scripted-env', objective: { description: 'x' }, mode: 'single-step', allowRisky: true })
    assert.equal(allowed.status, 'executed')
    assert.deepEqual(env2.executed, ['reset'])
  })

  it('escalates aborted when the caller cancels', async () => {
    const env = scriptedEnvironment({ states: [{ n: 0 }, { n: 1 }] })
    const { runtime } = harness({ decided: 'advance', environments: [env.adapter] })
    const controller = new AbortController()
    controller.abort()
    const outcome = await runtime.run({
      environment: 'scripted-env',
      objective: { description: 'x' },
      mode: 'bounded-loop',
      signal: controller.signal,
    })
    assert.equal(outcome.escalation?.reason, 'aborted')
    assert.deepEqual(env.executed, [])
  })

  it('escalates budget_exhausted when the wall clock runs out', async () => {
    const env = scriptedEnvironment({ states: [{ n: 0 }, { n: 1 }, { n: 2 }] })
    let clock = 0
    const registry = new DecisionProviderRegistry()
    registry.register(constantProvider('advance'), { enabled: true })
    const engine = new DecisionEngine({ defaultProviderId: 'scripted' }, registry)
    const environments = new EnvironmentRegistry()
    environments.register(env.adapter)
    const runtime = new DecisionRuntime(engine, {
      environments,
      config: { maxSteps: 10, maxDurationMs: 1, noProgressLimit: 10, repeatedDecisionLimit: 10, stepDelayMs: 5 },
      now: () => {
        clock += 10
        return clock
      },
    })
    const outcome = await runtime.run({ environment: 'scripted-env', objective: { description: 'x' }, mode: 'bounded-loop' })
    assert.equal(outcome.escalation?.reason, 'budget_exhausted')
  })

  it('surfaces an unknown environment as a thrown typed error, not an escalation', async () => {
    const { runtime } = harness({ decided: 'a' })
    await assert.rejects(runtime.run({ environment: 'ghost', objective: { description: 'x' } }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'environment_unknown'
    })
  })
})

describe('runtime configuration', () => {
  it('defaults are bounded and explicit', () => {
    assert.equal(DEFAULT_RUNTIME_CONFIG.maxSteps, 10)
    assert.ok(DEFAULT_RUNTIME_CONFIG.maxDurationMs > 0)
    assert.ok(DEFAULT_RUNTIME_CONFIG.noProgressLimit > 0)
    assert.ok(DEFAULT_RUNTIME_CONFIG.repeatedDecisionLimit > 0)
  })

  it('applies per-run overrides without mutating the base config', () => {
    const { runtime } = harness({ decided: 'a' })
    const resolved = runtime.resolveConfig({ maxSteps: 3 })
    assert.equal(resolved.maxSteps, 3)
    assert.equal(runtime.resolveConfig().maxSteps, DEFAULT_RUNTIME_CONFIG.maxSteps)
  })

  it('fingerprints state for progress detection without keeping it', () => {
    assert.equal(fingerprintState('abc', 10), 'abc')
    assert.equal(fingerprintState({ a: 1 }, 100), '{"a":1}')
    assert.equal(fingerprintState({ a: 1 }, 4), '{"a"')
    assert.equal(fingerprintState(undefined, 10), undefined)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.equal(fingerprintState(cyclic, 10), undefined)
  })
})

describe('runtime telemetry', () => {
  it('emits a step record per executed step with per-layer timings', async () => {
    const env = scriptedEnvironment({ states: [{ n: 0 }, { n: 1 }] })
    const records: unknown[] = []
    const registry = new DecisionProviderRegistry()
    registry.register(constantProvider('advance'), { enabled: true })
    const engine = new DecisionEngine({ defaultProviderId: 'scripted', telemetry: record => records.push(record) }, registry)
    const environments = new EnvironmentRegistry()
    environments.register(env.adapter)
    const runtime = new DecisionRuntime(engine, { environments, telemetry: record => records.push(record) })
    await runtime.run({
      environment: 'scripted-env',
      objective: { description: 'x' },
      mode: 'bounded-loop',
      config: { maxSteps: 3, noProgressLimit: 5, repeatedDecisionLimit: 5 },
    })
    const steps = (records as { kind: string; timings: Record<string, number> }[]).filter(record => record.kind === 'step')
    assert.ok(steps.length >= 2, `expected at least two step records, got ${steps.length}`)
    assert.ok((steps[0]?.timings.observeMs ?? -1) >= 0)
    assert.ok((steps[0]?.timings.decisionMs ?? -1) >= 0)
    // The mapping cost of step 0 is reported by step 1's record: a step record is
    // emitted at decide time, so the previous step's map/execute numbers travel
    // with the next decision.
    assert.ok((steps[1]?.timings.mapMs ?? -1) >= 0)
    assert.ok((steps[1]?.timings.executeMs ?? -1) >= 0)
    assert.equal(records.filter(record => (record as { kind: string }).kind === 'decision').length, 0, 'a runtime run must not double-report decisions')
    assert.ok(!JSON.stringify(records).includes('frozen'), 'telemetry must not carry environment state')
  })
})

/** A one-adapter environment registry, for tests that build their own engine. */
function registryEnvironment(adapter: EnvironmentAdapter): EnvironmentRegistry {
  const environments = new EnvironmentRegistry()
  environments.register(adapter)
  return environments
}
