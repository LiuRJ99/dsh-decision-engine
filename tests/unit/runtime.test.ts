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

  it('hands each plan stage its own scope through the adapter', async () => {
    // A stage declares what the driver may do while it is active, and the
    // adapter owns the meaning of that scope. This is what makes "answer this"
    // and "advance now" two decisions instead of one guess among both kinds of
    // control: the advance stage cannot be answered with an answer option
    // because none is offered.
    const scopes: string[] = []
    let state: { text: string } = { text: 'q1' }
    const make = (selector: string | undefined): EnvironmentAdapter => ({
      id: 'scoped-env',
      source: 'custom',
      observe: async () => ({ status: 'ok', source: 'custom', state }),
      buildDecisionRequest: () => ({
        objective: 'stage',
        state,
        candidates: selector === 'options'
          ? [{ id: 'answer', description: 'Answer the question' }]
          : [{ id: 'advance', description: 'Go to the next question' }],
        mode: 'choice' as const,
      }),
      mapDecision: (result) => ({ kind: 'custom', target: result.selected, candidateId: result.selected ?? '', description: 'x' }),
      execute: async (action) => {
        if (action.target === 'answer') state = { text: 'q1 answered' }
        if (action.target === 'advance') state = { text: 'q2' }
        return { ok: true, message: 'ok' }
      },
      withConfig: (scope) => {
        const selector = (scope as { candidateSelector?: string }).candidateSelector
        scopes.push(String(selector))
        return make(selector)
      },
    })
    const { runtime } = harness({ decided: ['answer', 'advance'], environments: [make(undefined)] })
    const outcome = await runtime.run({
      environment: 'scoped-env',
      objective: { description: 'Work through the questions' },
      mode: 'bounded-loop',
      plan: [
        { id: 'a1', objective: 'answer it', completion: { path: 'text', includes: 'answered' }, scope: { candidateSelector: 'options' }, maxSteps: 2 },
        { id: 'n1', objective: 'go on', completion: { path: 'text', includes: 'q2' }, scope: { candidateSelector: 'nav' }, maxSteps: 2 },
      ],
    })
    assert.equal(outcome.status, 'done')
    assert.deepEqual(outcome.completedPlanSteps, ['a1', 'n1'])
    assert.deepEqual(scopes, ['options', 'nav'])
  })

  it('refreshes the observation after a stage changes the candidate scope', async () => {
    let page = 'question'
    const observedScopes: string[] = []
    const make = (scope?: string): EnvironmentAdapter => ({
      id: 'filtered-env', source: 'custom',
      withConfig: next => make(next.candidateSelector as string),
      observe: async () => {
        observedScopes.push(scope ?? 'none')
        return {
          status: 'ok', source: 'custom',
          state: {
            page,
            controls: scope === 'options' ? (page === 'question' ? ['answer'] : []) : ['next'],
          },
        }
      },
      buildDecisionRequest: observation => ({
        objective: 'stage', state: observation.state as Record<string, unknown>,
        candidates: (observation.state as { controls: string[] }).controls.map(id => ({ id, description: id })),
        mode: 'choice',
      }),
      mapDecision: result => ({ kind: 'custom', candidateId: result.selected ?? '', description: 'stage' }),
      execute: async action => {
        page = action.candidateId === 'answer' ? 'answered' : 'next question'
        return { ok: true }
      },
    })
    const { runtime } = harness({ decided: 'unused', environments: [make()], runtimeConfig: { singleCandidateSteps: 'execute' } })
    const outcome = await runtime.run({
      environment: 'filtered-env', objective: { description: 'Answer and advance.' }, mode: 'bounded-loop',
      plan: [
        { id: 'answer', objective: 'Answer.', completion: { path: 'page', equals: 'answered' }, scope: { candidateSelector: 'options' } },
        { id: 'advance', objective: 'Advance.', completion: { path: 'page', equals: 'next question' }, scope: { candidateSelector: 'nav' } },
      ],
    })
    assert.equal(outcome.status, 'done')
    assert.deepEqual(outcome.completedPlanSteps, ['answer', 'advance'])
    assert.deepEqual(observedScopes, ['options', 'options', 'nav', 'nav'])
  })

  it('matches a completion substring inside a list-valued state path', async () => {
    // A planner asking "is this question answered?" wants to look at the
    // controls, not at one hard-coded index: element numbers churn, and a
    // page counter can lag. `interactive` is a list, so `includes` has to work
    // on lists too.
    let state: Record<string, unknown> = { text: 'q1', interactive: [{ name: 'A', domClassesUntrusted: 'option-item' }] }
    const adapter: EnvironmentAdapter = {
      id: 'list-env',
      source: 'custom',
      observe: async () => ({ status: 'ok', source: 'custom', state }),
      buildDecisionRequest: () => ({
        objective: 'answer', state,
        candidates: [{ id: 'pick', description: 'Pick A' }, { id: 'other', description: 'Pick B' }],
        mode: 'choice' as const,
      }),
      mapDecision: (result) => ({ kind: 'custom', target: result.selected, candidateId: result.selected ?? '', description: 'x' }),
      execute: async () => {
        state = { text: 'q1', interactive: [{ name: 'A', domClassesUntrusted: 'option-item selected' }] }
        return { ok: true, message: 'ok' }
      },
    }
    const { runtime } = harness({ decided: 'pick', environments: [adapter] })
    const outcome = await runtime.run({
      environment: 'list-env',
      objective: { description: 'x' },
      mode: 'bounded-loop',
      plan: [{ id: 'a1', objective: 'answer', completion: { path: 'interactive', includes: 'selected' }, maxSteps: 2 }],
    })
    assert.equal(outcome.status, 'done')
    assert.deepEqual(outcome.completedPlanSteps, ['a1'])
  })

  it('does not match an object key whose value says the condition is false', async () => {
    let selected = false
    const adapter: EnvironmentAdapter = {
      id: 'selected-env', source: 'custom',
      observe: async () => ({ status: 'ok', source: 'custom', state: { interactive: [{ name: 'A', selected }] } }),
      buildDecisionRequest: () => ({ objective: 'Select A', state: {}, candidates: [{ id: 'select', description: 'Select A' }], mode: 'choice' }),
      mapDecision: result => ({ kind: 'custom', candidateId: result.selected ?? '', description: 'Select A' }),
      execute: async () => { selected = true; return { ok: true } },
    }
    const { runtime } = harness({ decided: 'select', environments: [adapter], runtimeConfig: { singleCandidateSteps: 'execute' } })
    const outcome = await runtime.run({ environment: 'selected-env', objective: { description: 'Select A' }, mode: 'bounded-loop',
      plan: [{ id: 'select', objective: 'Select A', completion: { path: 'interactive', includes: 'selected' } }],
      config: { maxSteps: 1 },
    })
    assert.equal(outcome.steps, 1, 'a property name must not mark the untouched page complete')
  })

  it('executes a single-candidate step without asking the provider', async () => {
    // A stage scope can deliberately leave exactly one control ("advance now").
    // There is nothing to decide, and a small local head cannot answer it at
    // all (Laya's TopK needs k=2 over one class), so the runtime takes it.
    let state: { text: string } = { text: 'q1 answered' }
    const adapter: EnvironmentAdapter = {
      id: 'single-env',
      source: 'custom',
      observe: async () => ({ status: 'ok', source: 'custom', state }),
      buildDecisionRequest: () => ({
        objective: 'advance', state,
        candidates: [{ id: 'advance', description: 'Go to the next question' }],
        mode: 'choice' as const,
      }),
      mapDecision: (result) => ({ kind: 'custom', target: result.selected, candidateId: result.selected ?? '', description: 'x' }),
      execute: async () => { state = { text: 'q2' }; return { ok: true, message: 'ok' } },
    }
    const { runtime, provider } = harness({ decided: 'advance', environments: [adapter], runtimeConfig: { singleCandidateSteps: 'execute' } })
    const outcome = await runtime.run({
      environment: 'single-env',
      objective: { description: 'x' },
      mode: 'bounded-loop',
      plan: [{ id: 'n1', objective: 'advance', completion: { path: 'text', includes: 'q2' }, maxSteps: 2 }],
    })
    assert.equal(outcome.status, 'done')
    assert.equal(outcome.decision?.provider, 'single-candidate')
    assert.equal(outcome.decision?.selected, 'advance')
    // The provider was never consulted for this step.
    assert.equal((provider as unknown as { calls: unknown[] }).calls.length, 0)
  })

  it('judges progress on the adapter key, not on element numbering that churns', async () => {
    // Indices are addressing. A page that rebuilds its controls returns new
    // numbers for an unchanged situation, so a whole-state fingerprint reports
    // "changed" forever and the stall guard never fires (measured on a quiz
    // page: 161 steps, two recorded answers, no `no_progress`).
    let calls = 0
    const adapter: EnvironmentAdapter = {
      id: 'churn-env',
      source: 'custom',
      observe: async () => {
        calls += 1
        return { status: 'ok', source: 'custom', state: { text: 'same', items: [{ index: calls, name: 'Next' }] } }
      },
      progressKey: (state) => {
        const view = state as { text: string; items: { name: string }[] }
        return { text: view.text, items: view.items.map(item => item.name) }
      },
      buildDecisionRequest: () => ({
        objective: 'x', state: { text: 'same' },
        candidates: [{ id: 'noop', description: 'Nothing changes' }], mode: 'choice' as const,
      }),
      mapDecision: (result) => ({ kind: 'custom', target: result.selected, candidateId: result.selected ?? '', description: 'x' }),
      execute: async () => ({ ok: true, message: 'ok' }),
    }
    const { runtime } = harness({ decided: 'noop', environments: [adapter] })
    const outcome = await runtime.run({ environment: 'churn-env', objective: { description: 'x' }, mode: 'bounded-loop' })
    assert.equal(outcome.status, 'needs_escalation')
    assert.match(outcome.stopReason ?? '', /did not change/)
  })

  it('rejects a plan stage whose scope is not an object', async () => {
    const { runtime } = harness({ decided: 'advance', environments: [scriptedEnvironment({ states: ['a', 'b'] }).adapter] })
    await assert.rejects(
      () => runtime.run({
        environment: 'scripted-env',
        objective: { description: 'x' },
        plan: [{ id: 's1', objective: 'x', completion: { path: 'text', includes: 'a' }, scope: [] as unknown as Record<string, unknown> }],
      }),
      /scope/,
    )
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
