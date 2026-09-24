import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { BrowserEnvironmentAdapter } from '../../src/environments/browser/adapter.ts'
import { parseBrowserSnapshot } from '../../src/environments/browser/snapshot.ts'
import { createMapDispatcher } from '../../src/environments/dispatch.ts'
import { Config, createDecisionEngineComposition } from '../../src/composition.ts'
import { executeDecide } from '../../src/tools/decide-logic.ts'
import { executeRunTask } from '../../src/tools/decision-run.ts'
import { ScriptedProvider } from '../helpers.ts'

const text = 'Title: Quiz\nStatus: complete\nMain content:\nChoose A\nInteractive elements:\n  [7] clickable "A" [classes=option%20selected]\n  [8] clickable "Disabled" [disabled]\n  [1] button "Next"'
const objective = { description: 'Choose A' }

it('derives page controls when settings resolve an omitted candidate list to empty', async () => {
  const snapshot = 'Title: Quiz\nStatus: complete\nMain content:\nChoose a bank\nInteractive elements:\n  [6] button "📚 加载示例题库"\n  [7] button "▶ 开始"'
  const config = Config({ providers: { laya: { enabled: false } } })
  assert.deepEqual(config.browser?.candidates, [])
  const created = createDecisionEngineComposition({
    config,
    dispatcher: createMapDispatcher({ browser_snapshot: () => ({ ok: true, text: snapshot }) }),
  })
  const browser = created.environments.require('browser')
  const request = await browser.buildDecisionRequest(await browser.observe(), { description: 'Load sample bank' })
  assert.deepEqual(request.candidates.map(candidate => candidate.description), [
    'Activate "📚 加载示例题库"', 'Activate "▶ 开始"',
  ])
  await created.dispose()
})

it('keeps a non-empty configured browser candidate set in patch mode', async () => {
  const config = Config({
    providers: { laya: { enabled: false } },
    browser: { candidates: [{ id: 'load', description: 'Load the bank', action: { kind: 'click', target: 6 } }] },
  })
  const created = createDecisionEngineComposition({
    config,
    dispatcher: createMapDispatcher({ browser_snapshot: () => ({ ok: true, text: 'Title: Quiz\nStatus: complete\nInteractive elements:\n  [6] button "📚 加载示例题库"' }) }),
  })
  const browser = created.environments.require('browser')
  const request = await browser.buildDecisionRequest(await browser.observe(), { description: 'Load sample bank' })
  assert.deepEqual(request.candidates.map(candidate => candidate.description), ['Load the bank'])
  await created.dispose()
})

it('distinguishes false states and retains untrusted raw class evidence', () => {
  const snapshot = parseBrowserSnapshot('Interactive elements:\n  [1] checkbox "A" [unchecked/unselected/unpressed/classes=option%20selected/outside viewport]')
  assert.equal(snapshot.items[0]?.checked, false)
  assert.equal(snapshot.items[0]?.selected, false)
  assert.equal(snapshot.items[0]?.pressed, false)
  assert.equal(snapshot.items[0]?.domClasses, 'option selected')
  assert.equal(snapshot.items[0]?.outsideViewport, true)
})

it('opts in per adapter without changing default candidates, order or index binding', async () => {
  const dispatcher = createMapDispatcher({ browser_snapshot: args => ({ ok: true,
    text: args.includeNonSemantic ? 'Inventory scope: {"includeNonSemantic":true}\n' + text : text }) })
  const base = new BrowserEnvironmentAdapter({ dispatcher })
  const configured = base.withConfig({ includeNonSemantic: true })
  const observation = await configured.observe()
  const request = configured.buildDecisionRequest(observation, objective)
  assert.deepEqual(request.candidates.map(c => c.description), ['Activate "A"', 'Activate "Next"'])
  const action = configured.mapDecision({ provider: 'test', mode: 'choice', selected: request.candidates[0]!.id, latencyMs: 0 }, observation)
  assert.equal(action.target, 7)
  assert.deepEqual(base.buildDecisionRequest(await base.observe(), objective).candidates.map(c => c.description), ['Activate "Next"'])
  assert.equal((request.state as any).interactive[0].domClassesUntrusted, 'option selected')
})

it('refuses an old extension or a mismatched scope rather than acting on the whole page', async () => {
  for (const prefix of ['', 'Inventory scope: {"includeNonSemantic":true,"candidateSelector":".wrong"}\n']) {
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: createMapDispatcher({ browser_snapshot: () => ({ ok: true, text: prefix + text }) }), config: { includeNonSemantic: true, candidateSelector: '.option' } })
    assert.equal((await adapter.observe()).status, 'insufficient')
  }
})

it('passes task-local scope through both tools and leaves registered settings intact', async () => {
  const calls: Record<string, unknown>[] = []
  const provider = new ScriptedProvider({ id: 'test', plan: request => ({ provider: 'test', mode: 'choice', selected: request.candidates[0]!.id, latencyMs: 0 }) })
  const composition = createDecisionEngineComposition({ config: { providers: { laya: { enabled: false } } }, extraProviders: [{ provider }], dispatcher: createMapDispatcher({
    browser_snapshot: args => { calls.push(args); return { ok: true, text: 'Inventory scope: ' + JSON.stringify({ includeNonSemantic: args.includeNonSemantic === true, ...(args.candidateSelector === undefined ? {} : { candidateSelector: args.candidateSelector }) }) + '\n' + text } },
  }) })
  const browser = { includeNonSemantic: true, candidateSelector: '.option', maxCandidates: 1 }
  const preview = await executeDecide({ environment: 'browser', objective: 'Choose A', browser }, { service: composition.service })
  assert.equal(preview.action?.target, 7)
  const run = await executeRunTask({ environment: 'browser', objective: 'Read the quiz', browser, completion: { path: 'main', includes: 'Choose A' } }, composition.service)
  assert.equal(run.status, 'done')
  assert.equal(run.steps, 0)
  assert.ok(calls.every(args => args.includeNonSemantic === true && args.candidateSelector === '.option'))
  await composition.environments.require('browser').observe()
  assert.deepEqual(calls.at(-1), {})
  await assert.rejects(executeRunTask({ endpoint: 'http://localhost', objective: 'x', browser }, composition.service), /Browser settings/)
  await assert.rejects(executeDecide({ environment: 'computer', objective: 'x', browser }, { service: composition.service }), /BrowserEnvironmentAdapter/)
  await composition.service.dispose()
})

it('rejects invalid candidate settings before any observation', () => {
  const dispatcher = createMapDispatcher({})
  for (const maxCandidates of [0, 65, 1.5, NaN]) assert.throws(() => new BrowserEnvironmentAdapter({ dispatcher, config: { maxCandidates } }), /1 and 64/)
  assert.throws(() => new BrowserEnvironmentAdapter({ dispatcher, config: { candidateSelector: '' } }), /non-empty/)
})
