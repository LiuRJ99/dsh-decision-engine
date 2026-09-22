import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import { createDecisionLayer, CustomEnvironmentAdapter, HttpEnvironmentAdapter, ENVIRONMENT_PROTOCOL } from '../../src/embed.ts'
import type { EnvironmentActionRequest, EnvironmentSnapshot } from '../../src/environments/http/adapter.ts'
import type { DecisionProvider } from '../../src/core/types.ts'
import { createDecisionEngineComposition } from '../../src/composition.ts'
import { defineRunTool } from '../../src/tools/decision-run.ts'
import { apply } from '../../src/plugin.ts'
import { BrowserEnvironmentAdapter } from '../../src/environments/browser/adapter.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { DecisionEngineService } from '../../src/service.ts'

function picker(onCall?: () => void): DecisionProvider {
  return {
    id: 'test-policy', capabilities: ['choice'],
    async decide(request) {
      onCall?.()
      return { provider: 'test-policy', mode: 'choice', selected: request.candidates[0]!.id, latencyMs: 0 }
    },
  }
}

async function httpGame(options: { over?: boolean; rejectStale?: boolean; changeEpisode?: boolean } = {}) {
  let position = options.over ? 20 : 0
  let gets = 0
  let posts = 0
  const actions: EnvironmentActionRequest[] = []
  const snapshot = (): EnvironmentSnapshot => ({
    protocol: ENVIRONMENT_PROTOCOL, environmentId: 'corridor', episodeId: 'round-1', revision: String(position),
    state: { position, score: position * 10 }, done: position >= 20,
    candidates: position >= 20 ? [] : [{ id: 'right', description: 'Move right and collect a coin.' }],
    ...position < 20 ? {} : { result: { score: 200, outcome: 'won' } },
  })
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/env/state' && req.method === 'GET') { gets++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(snapshot())); return }
    if (req.url !== '/env/action' || req.method !== 'POST') { res.writeHead(404).end(); return }
    posts++
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const action = JSON.parse(body) as EnvironmentActionRequest
    actions.push(action)
    if (options.rejectStale || action.revision !== String(position) || action.episodeId !== 'round-1') { res.writeHead(409).end(); return }
    assert.equal(action.environmentId, 'corridor')
    assert.equal(action.candidateId, 'right')
    position++
    const next = snapshot()
    if (options.changeEpisode) next.episodeId = 'round-2'
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, observation: next }))
  }
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.writeHead(500).end()) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    endpoint: `http://127.0.0.1:${address.port}/env`, actions,
    counts: () => ({ position, gets, posts }),
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() }),
  }
}

describe('independent task takeover', () => {
  it('one DSH tool call plays a whole HTTP game and returns the authoritative score', async () => {
    const game = await httpGame()
    let decisions = 0
    let hostToolCalls = 0
    const composition = createDecisionEngineComposition({
      config: { providers: { laya: { enabled: false } }, browser: { enabled: false }, computer: { enabled: false } },
      dispatcher: { call: async () => { hostToolCalls++; throw new Error('Game tasks must not use a main-agent relay.') } },
      extraProviders: [{ provider: picker(() => decisions++) }],
    })
    try {
      const tool = defineRunTool(composition.service)
      const result = await tool.execute({ endpoint: game.endpoint, objective: 'Finish the game and report the score.' }, {
        signal: new AbortController().signal,
      } as ToolRunContext) as { status: string; steps: number; result: unknown; taskId: string }
      assert.equal(result.status, 'done')
      assert.equal(result.steps, 20)
      assert.deepEqual(result.result, { score: 200, outcome: 'won' })
      assert.equal(decisions, 20)
      assert.equal(hostToolCalls, 0)
      assert.deepEqual(game.counts(), { position: 20, gets: 1, posts: 20 })
      assert.equal(new Set(game.actions.map(action => action.actionId)).size, 20)
      assert.deepEqual(game.actions.map(action => action.revision), Array.from({ length: 20 }, (_, i) => String(i)))
      assert.ok(result.taskId)
    } finally { await composition.dispose(); await game.close() }
  })

  it('the same task executor works without DSH and accepts a finished empty ballot', async () => {
    const game = await httpGame({ over: true })
    let modelCalls = 0
    const layer = createDecisionLayer({ laya: false, providers: [picker(() => modelCalls++)] })
    try {
      const result = await layer.runTask({ environment: new HttpEnvironmentAdapter({ endpoint: game.endpoint }), objective: 'Complete this game.' })
      assert.equal(result.status, 'done')
      assert.equal(result.steps, 0)
      assert.equal(modelCalls, 0)
      assert.deepEqual(result.result, { score: 200, outcome: 'won' })
      assert.equal(game.counts().posts, 0)
    } finally { await layer.dispose(); await game.close() }
  })

  for (const kind of ['rejectStale', 'changeEpisode'] as const) {
    it(`stops on ${kind} without retrying an action or controlling another episode`, async () => {
      const game = await httpGame({ [kind]: true })
      const layer = createDecisionLayer({ laya: false, providers: [picker()] })
      try {
        const result = await layer.runTask({ environment: new HttpEnvironmentAdapter({ endpoint: game.endpoint }), objective: 'Play.' })
        assert.equal(result.status, 'needs_escalation')
        assert.equal(game.counts().posts, 1)
        assert.equal(result.escalation?.reason, kind === 'rejectStale' ? 'action_execution_failed' : 'environment_unavailable')
      } finally { await layer.dispose(); await game.close() }
    })
  }

  it('does not call the model at a terminal custom state and returns its score', async () => {
    const layer = createDecisionLayer({ laya: false, providers: [picker(() => assert.fail('No inference at a terminal state'))] })
    const game = new CustomEnvironmentAdapter({ id: 'over', observe: () => ({ score: 7 }), candidates: [], execute: () => ({ ok: true }), isDone: () => true, result: state => ({ score: state.score }) })
    const result = await layer.runTask({ environment: game, objective: 'Play.' })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.result, { score: 7 })
    await layer.dispose()
  })

  it('expires a hung observation promptly and retains the environment lease until it drains', async () => {
    const layer = createDecisionLayer({ laya: false, providers: [picker()] })
    let release!: (value: { n: number }) => void
    let moves = 0
    const adapter = new CustomEnvironmentAdapter({ id: 'slow', observe: () => new Promise<{ n: number }>(resolve => { release = resolve }), candidates: [{ id: 'go', description: 'go' }], execute: () => { moves++; return { ok: true } } })
    const result = await layer.runTask({ environment: adapter, objective: 'Play.', config: { maxDurationMs: 20 } })
    assert.equal(result.escalation?.reason, 'budget_exhausted')
    assert.equal(moves, 0)
    await assert.rejects(layer.runTask({ environment: adapter, objective: 'Play.' }), /active or draining/)
    release({ n: 0 })
    await sleep(1)
    assert.equal(moves, 0)
    await layer.dispose()
  })

  it('cancellation during inference prevents the next action', async () => {
    const controller = new AbortController()
    const layer = createDecisionLayer({ laya: false, providers: [picker(() => controller.abort())] })
    let actions = 0
    const adapter = new CustomEnvironmentAdapter({ id: 'cancel', observe: () => ({ n: 0 }), candidates: [{ id: 'go', description: 'go' }], execute: () => { actions++; return { ok: true } } })
    const result = await layer.runTask({ environment: adapter, objective: 'Play.', signal: controller.signal })
    assert.equal(result.escalation?.reason, 'aborted')
    assert.equal(actions, 0)
    await layer.dispose()
  })

  it('candidate payloads remain bound to their original observation', async () => {
    let frame = 1
    const adapter = new CustomEnvironmentAdapter({ id: 'frames', observe: () => ({ frame }), candidates: state => [{ id: 'move', description: 'move', action: { frame: state.frame } }], execute: () => ({ ok: true }) })
    const first = await adapter.observe()
    adapter.buildDecisionRequest(first, { description: 'Play.' })
    frame = 2
    adapter.buildDecisionRequest(await adapter.observe(), { description: 'Play.' })
    const action = adapter.mapDecision({ provider: 'test-policy', mode: 'choice', selected: 'move', latencyMs: 0 }, first)
    assert.deepEqual(action.payload, { frame: 1 })
  })

  it('a browser takeover clicks through questions and stops before the restart link', async () => {
    let screen = 0
    const clicks: number[] = []
    const browser = new BrowserEnvironmentAdapter({ dispatcher: { async call(request) {
      if (request.name === 'browser_click') { clicks.push(Number(request.arguments.index)); screen++; return { ok: true, text: 'clicked' } }
      const text = screen >= 6 ? 'All questions completed. Score: 3.' : `Question ${Math.floor(screen / 2) + 1}`
      const control = screen >= 6 ? 'Start over' : screen % 2 === 0 ? 'Answer A' : 'Next question'
      return { ok: true, text: `Title: Quiz\nURL: https://quiz.test/\nStatus: complete\n\nMain content:\n${text}\n\nInteractive elements:\n  [1] button "${control}"` }
    } } })
    const layer = createDecisionLayer({ laya: false, providers: [picker()] })
    const result = await layer.runTask({ environment: browser, objective: { description: 'Finish all questions.', completion: { path: 'main', includes: 'All questions completed' } } })
    assert.equal(result.status, 'done')
    assert.equal(clicks.length, 6)
    assert.equal(screen, 6)
    await layer.dispose()
  })

  it('recognizes a short result page without any controls before requesting a decision', async () => {
    const browser = new BrowserEnvironmentAdapter({ dispatcher: { async call() {
      return { ok: true, text: 'Title: Results\nURL: https://quiz.test/\nStatus: complete\n\nMain content:\nScore: 100\n\nInteractive elements:' }
    } } })
    const layer = createDecisionLayer({ laya: false, providers: [picker(() => assert.fail('Result pages need no further decision'))] })
    try {
      const result = await layer.runTask({ environment: browser, objective: { description: 'Finish the quiz.', completion: { path: 'main', includes: 'Score: 100' } } })
      assert.equal(result.status, 'done')
      assert.equal(result.steps, 0)
      assert.match(JSON.stringify(result.finalState), /Score: 100/)
    } finally { await layer.dispose() }
  })

  it('executes a main-agent plan end to end and changes the model objective at stage boundaries', async () => {
    let screen = 0
    const objectives: string[] = []
    const clicks: number[] = []
    const browser = new BrowserEnvironmentAdapter({ dispatcher: { async call(request) {
      if (request.name === 'browser_click') { clicks.push(Number(request.arguments.index)); screen++; return { ok: true, text: 'clicked' } }
      const pages = [
        ['Dashboard', 'Enter quiz'], ['Question 1: select A', 'Answer A'], ['Ready for question 2', 'Next question'],
        ['Question 2: select B', 'Answer B'], ['Ready to submit', 'Submit all'], ['Final score: 2 / 2', undefined],
      ]
      const [main, button] = pages[screen]!
      return { ok: true, text: `Title: Training\nURL: https://quiz.test/\nStatus: complete\n\nMain content:\n${main}\n\nInteractive elements:\n${button === undefined ? '' : `  [1] button "${button}"`}` }
    } } })
    const provider = picker()
    const decide = provider.decide.bind(provider)
    provider.decide = async (request, context) => { objectives.push(request.objective ?? ''); return decide(request, context) }
    const layer = createDecisionLayer({ laya: false, providers: [provider] })
    try {
      const result = await layer.runTask({
        environment: browser, objective: 'Complete the training quiz and return the result.',
        plan: [
          { id: 'enter', objective: 'Open the quiz from the dashboard.', completion: { path: 'main', includes: 'Question 1:' } },
          { id: 'answer', objective: 'Answer each question and click next until ready to submit.', completion: { path: 'main', includes: 'Ready to submit' } },
          { id: 'submit', objective: 'Submit all answers and wait for the final score.', completion: { path: 'main', includes: 'Final score:' } },
        ],
      })
      assert.equal(result.status, 'done')
      assert.equal(clicks.length, 5)
      assert.deepEqual(result.completedPlanSteps, ['enter', 'answer', 'submit'])
      assert.equal(result.activePlanStep, undefined)
      assert.deepEqual(objectives.map(value => /Current plan step \(([^)]+)\)/.exec(value)?.[1]), ['enter', 'answer', 'answer', 'answer', 'submit'])
      assert.match(JSON.stringify(result.finalState), /Final score: 2 \/ 2/)
    } finally { await layer.dispose() }
  })

  it('returns the blocked plan stage without silently skipping or replanning it', async () => {
    let n = 0
    const adapter = new CustomEnvironmentAdapter({ id: 'blocked', observe: () => ({ n }), candidates: [{ id: 'a', description: 'A' }], execute: () => { n++; return { ok: true } } })
    const layer = createDecisionLayer({ laya: false, providers: [picker()] })
    try {
      const result = await layer.runTask({ environment: adapter, objective: 'Finish.', plan: [
        { id: 'first', objective: 'Reach three.', completion: { path: 'n', equals: 3 }, maxSteps: 2 },
        { id: 'last', objective: 'Reach four.', completion: { path: 'n', equals: 4 } },
      ] })
      assert.equal(result.escalation?.reason, 'budget_exhausted')
      assert.equal(n, 2)
      assert.equal(result.activePlanStep, 'first')
      assert.deepEqual(result.completedPlanSteps, [])
    } finally { await layer.dispose() }
  })

  it('honors the model deadline within a longer whole-task budget', async () => {
    const layer = createDecisionLayer({ laya: false, timeoutMs: 10, providers: [{ id: 'hung', capabilities: ['choice'], decide: () => new Promise(() => {}) }] })
    const adapter = new CustomEnvironmentAdapter({ id: 'quiz', observe: () => ({ question: 1 }), candidates: [{ id: 'a', description: 'A' }], execute: () => assert.fail('A timed-out decision must never execute') })
    try {
      const result = await layer.runTask({ environment: adapter, objective: 'Finish.', config: { maxDurationMs: 1000 } })
      assert.equal(result.escalation?.reason, 'provider_timeout')
    } finally { await layer.dispose() }
  })

  it('reports an uncertain in-flight action on cancellation and retains control until it drains', async () => {
    const controller = new AbortController()
    let finish!: (value: { ok: boolean }) => void
    const layer = createDecisionLayer({ laya: false, providers: [picker()] })
    const adapter = new CustomEnvironmentAdapter({ id: 'uncertain', observe: () => ({ n: 1 }), candidates: [{ id: 'a', description: 'A' }], execute: () => new Promise<{ ok: boolean }>(resolve => { finish = resolve; controller.abort() }) })
    try {
      const result = await layer.runTask({ environment: adapter, objective: 'Finish.', signal: controller.signal })
      assert.equal(result.escalation?.reason, 'aborted')
      assert.equal(result.escalation?.details?.actionMayHaveExecuted, true)
      await assert.rejects(layer.runTask({ environment: adapter, objective: 'Finish.' }), /active or draining/)
      finish({ ok: true })
      await sleep(1)
    } finally { await layer.dispose() }
  })

  it('host takeover retains the initiating agent and parent for every nested call', async () => {
    const definitions = new Map<string, ToolDefinition>()
    const services = new Map<string, unknown>()
    const calls: Array<{ name: string; agent?: unknown; parent?: unknown }> = []
    let screen = 0
    let seamCalls = 0
    const tools = {
      register(definition: ToolDefinition) { definitions.set(definition.name, definition); return () => {} },
      async execute(call: { name: string; agent?: unknown; parent?: unknown }) {
        calls.push(call)
        if (call.name === 'browser_click') screen++
        return { isError: false, content: [{ type: 'text', text: `Title: Quiz\nURL: https://quiz.test/\nStatus: complete\n\nMain content:\n${screen === 0 ? 'Question' : 'Finished'}\n\nInteractive elements:\n  [1] button "Continue"` }] }
      },
    }
    const ctx = {
      tools,
      get: (name: string) => name === 'tools' ? tools : name === 'computer' ? { click: () => { seamCalls++ } } : services.get(name),
      provide: (name: string, value: unknown) => services.set(name, value),
      effect: () => {}, inject: () => {}, systemPrompt: { section: () => {} },
    }
    apply(ctx as never, { providers: { laya: { enabled: false } } })
    const service = services.get('decisionEngine') as DecisionEngineService
    service.providers.register(picker())
    const agent = { id: 'game-owner' }
    const parent = { token: 'outer-task' }
    const result = await definitions.get('decision_run')!.execute({ environment: 'browser', objective: 'Finish.', completion: { path: 'main', includes: 'Finished' } }, {
      agent, token: parent, rootCallId: 'root', signal: new AbortController().signal,
    } as unknown as ToolRunContext) as { status: string }
    assert.equal(result.status, 'done')
    assert.ok(calls.length >= 3)
    for (const call of calls) { assert.equal(call.agent, agent); assert.equal(call.parent, parent) }
    assert.equal(seamCalls, 0)
    await service.dispose()
  })
})
