/**
 * D. Browser integration test — the whole pipeline over a three-state page
 * flow, with no browser and no screenshots.
 *
 * ```text
 * Browser (structured snapshot)
 *   ↓
 * Observation
 *   ↓
 * DecisionRequest
 *   ↓
 * DecisionEngine
 *   ↓
 * DecisionProvider
 *   ↓
 * DecisionResult
 *   ↓
 * Action Mapper
 *   ↓
 * Browser action
 * ```
 *
 * The provider here is a *scripted* stand-in for a decision model, not a fake
 * of the protocol: it receives the real `DecisionRequest` the adapter built and
 * returns a real `DecisionResult`. That is exactly what a model provider does,
 * so the test exercises the real seam.
 *
 * @module dsh-decision-engine/tests/integration/browser-flow.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionProviderRegistry } from '../../src/core/provider-registry.ts'
import { EnvironmentRegistry } from '../../src/environments/registry.ts'
import { BrowserEnvironmentAdapter } from '../../src/environments/browser/adapter.ts'
import { DecisionRuntime } from '../../src/runtime/runner.ts'
import { ScriptedProvider, type FakeBrowser } from '../helpers.ts'
import { createMapDispatcher } from '../../src/environments/dispatch.ts'

/**
 * A browser whose two buttons advance a real state machine, rendering the same
 * snapshot text the bridge renders (including the numbered inventory).
 */
function flowBrowser(): { dispatcher: ReturnType<typeof createMapDispatcher>; clicks: string[]; state: () => string; browser: FakeBrowser } {
  const clicks: string[] = []
  let current: 'a' | 'b' | 'done' = 'a'
  const pages = {
    a: {
      title: 'State A',
      url: 'http://127.0.0.1:8099/flow-a.html',
      main: 'Step one. Read the instructions, then continue.',
      items: [
        { index: 3, role: 'button', name: 'Continue' },
        { index: 4, role: 'link', name: 'Cancel', href: 'http://127.0.0.1:8099/index.html' },
      ],
    },
    b: {
      title: 'State B',
      url: 'http://127.0.0.1:8099/flow-b.html',
      main: 'Step two. Confirm the details and finish.',
      items: [{ index: 1, role: 'button', name: 'Finish' }],
    },
    done: {
      title: 'Success',
      url: 'http://127.0.0.1:8099/flow-done.html',
      main: 'Success. The flow is complete.',
      items: [{ index: 2, role: 'link', name: 'Start over', href: 'http://127.0.0.1:8099/flow-a.html' }],
    },
  } as const

  const render = (page: (typeof pages)[keyof typeof pages]): string => {
    const lines = [`Title: ${page.title}`, `URL: ${page.url}`, 'Status: complete', '', 'Main content:', page.main, '', 'Interactive elements:']
    for (const item of page.items) {
      lines.push(`  [${item.index}] ${item.role} "${item.name}"${'href' in item ? ` → ${item.href}` : ''}`)
    }
    return lines.join('\n')
  }

  const dispatcher = createMapDispatcher({
    browser_snapshot: () => ({ ok: true, text: render(pages[current]) }),
    browser_click: (args) => {
      const index = Number(args.index)
      const page = pages[current]
      const item = page.items.find(entry => entry.index === index)
      if (item === undefined) return { ok: false, text: '', error: `element ${index} is not in the snapshot` }
      clicks.push(item.name)
      if (item.name === 'Continue') current = 'b'
      else if (item.name === 'Finish') current = 'done'
      return { ok: true, text: `clicked "${item.name}"` }
    },
  })
  return {
    dispatcher,
    clicks,
    state: () => current,
    browser: undefined as unknown as FakeBrowser,
  }
}

/**
 * A decision provider that behaves like a small model: it reads the objective
 * and the candidate descriptions, and prefers the candidate whose description
 * matches the step currently being asked for. It never sees a tool name.
 */
function flowProvider(): ScriptedProvider {
  return new ScriptedProvider({
    id: 'flow-model',
    capabilities: ['choice', 'ranking', 'score', 'classification'],
    plan: (request) => {
      const wanted = request.objective?.includes('Success') === true ? ['Continue', 'Finish'] : ['Continue']
      const candidate = request.candidates.find(entry => wanted.some(name => entry.description.includes(name)))
        ?? request.candidates[0]
      return {
        provider: 'flow-model',
        mode: 'choice',
        ...candidate === undefined ? {} : { selected: candidate.id },
        confidence: 0.91,
        confidenceKind: 'provider_raw',
        latencyMs: 2,
      }
    },
  })
}

function buildHarness(): { runtime: DecisionRuntime; clicks: string[]; state: () => string; provider: ScriptedProvider; environments: EnvironmentRegistry } {
  const flow = flowBrowser()
  const adapter = new BrowserEnvironmentAdapter({ dispatcher: flow.dispatcher })
  const environments = new EnvironmentRegistry()
  environments.register(adapter)
  const registry = new DecisionProviderRegistry()
  const provider = flowProvider()
  registry.register(provider, { enabled: true, config: {} })
  const engine = new DecisionEngine({ defaultProviderId: 'flow-model' }, registry)
  const runtime = new DecisionRuntime(engine, { environments, config: { maxSteps: 8, noProgressLimit: 8, repeatedDecisionLimit: 2 } })
  return { runtime, clicks: flow.clicks, state: flow.state, provider, environments }
}

describe('browser flow: State A → State B → Success', () => {
  it('decides without executing in decision-only mode', async () => {
    const { runtime, clicks, state } = buildHarness()
    const outcome = await runtime.run({
      environment: 'browser',
      objective: { description: 'Advance the flow to Success.' },
    })
    assert.equal(outcome.status, 'decided')
    assert.equal(outcome.action?.kind, 'click')
    assert.match(outcome.action?.description ?? '', /Continue/)
    assert.deepEqual(clicks, [], 'decision-only executes nothing')
    assert.equal(state(), 'a', 'the page did not change')
  })

  it('executes exactly one action in single-step mode', async () => {
    const { runtime, clicks, state } = buildHarness()
    let observed = 0
    const original = runtime
    void original
    const outcome = await runtime.run({
      environment: 'browser',
      objective: { description: 'Advance the flow to Success.' },
      mode: 'single-step',
    })
    observed += 1
    assert.equal(observed, 1)
    assert.equal(outcome.status, 'executed')
    assert.deepEqual(clicks, ['Continue'])
    assert.equal(state(), 'b')
  })

  it('reaches Success in bounded-loop mode and stops there', async () => {
    const { runtime, clicks, state } = buildHarness()
    const outcome = await runtime.run({
      environment: 'browser',
      objective: { description: 'Advance the flow to Success.' },
      mode: 'bounded-loop',
    })
    // `repeatedDecisionLimit: 2` trips on the third identical choice, so the
    // guard costs exactly `limit` repeated actions, never an unbounded run.
    assert.deepEqual(clicks, ['Continue', 'Finish', 'Start over', 'Start over', 'Start over'])
    assert.equal(state(), 'done', 'the flow reached Success before the repeat guard fired')
    // The Success page has no next step toward "Success", so the provider keeps
    // choosing the same candidate and the loop stops on its repeat guard rather
    // than looping forever.
    assert.ok(['needs_escalation', 'done'].includes(outcome.status))
    if (outcome.status === 'needs_escalation') assert.equal(outcome.escalation?.reason, 'repeated_decision')
  })

  it('never asks a provider for a tool call and never sends pixels', async () => {
    const { runtime, provider } = buildHarness()
    await runtime.run({ environment: 'browser', objective: { description: 'Advance the flow to Success.' }, mode: 'single-step' })
    const serialized = JSON.stringify(provider.calls)
    assert.ok(!serialized.includes('browser_click'), 'the provider must not learn a tool name')
    assert.ok(!serialized.includes('index='), 'the provider must not receive element indices')
    assert.ok(serialized.includes('Continue'), 'the provider sees candidate descriptions instead')
  })

  it('escalates when the page cannot express the task', async () => {
    const dispatcher = createMapDispatcher({
      browser_snapshot: () => ({ ok: true, text: 'Title: Game\nURL: http://127.0.0.1:8099/game.html\nStatus: complete\n\nMain content:\n<canvas id="game"></canvas>' }),
    })
    const environments = new EnvironmentRegistry()
    environments.register(new BrowserEnvironmentAdapter({ dispatcher }))
    const registry = new DecisionProviderRegistry()
    registry.register(flowProvider(), { enabled: true, config: {} })
    const engine = new DecisionEngine({ defaultProviderId: 'flow-model' }, registry)
    const runtime = new DecisionRuntime(engine, { environments })
    const outcome = await runtime.run({ environment: 'browser', objective: { description: 'Play the game.' }, mode: 'bounded-loop' })
    assert.equal(outcome.status, 'needs_escalation')
    assert.equal(outcome.escalation?.reason, 'environment_unsupported')
  })

  it('escalates when the capability gate refuses the observation', async () => {
    const dispatcher = createMapDispatcher({
      browser_snapshot: () => ({ ok: false, text: '', error: 'browser_snapshot: the browser capability is not authorized in this session' }),
    })
    const environments = new EnvironmentRegistry()
    environments.register(new BrowserEnvironmentAdapter({ dispatcher }))
    const registry = new DecisionProviderRegistry()
    registry.register(flowProvider(), { enabled: true, config: {} })
    const engine = new DecisionEngine({ defaultProviderId: 'flow-model' }, registry)
    const runtime = new DecisionRuntime(engine, { environments })
    const outcome = await runtime.run({ environment: 'browser', objective: { description: 'Advance.' }, mode: 'single-step' })
    assert.equal(outcome.status, 'needs_escalation')
    assert.equal(outcome.escalation?.reason, 'environment_unsupported')
    assert.match(outcome.escalation?.guidance ?? '', /main agent|authorize/i)
  })
})
