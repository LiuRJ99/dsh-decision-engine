/**
 * C. Environment tests — the browser, computer, and custom adapters, plus the
 * paths that must refuse to guess.
 *
 * @module dsh-decision-engine/tests/unit/environments.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionError } from '../../src/core/errors.ts'
import type { DecisionResult } from '../../src/core/types.ts'
import { BrowserEnvironmentAdapter } from '../../src/environments/browser/adapter.ts'
import { looksCanvasLike, parseBrowserSnapshot } from '../../src/environments/browser/snapshot.ts'
import { ComputerEnvironmentAdapter } from '../../src/environments/computer/adapter.ts'
import { parseAxTree } from '../../src/environments/computer/ax-tree.ts'
import { CustomEnvironmentAdapter } from '../../src/environments/custom/adapter.ts'
import { EnvironmentRegistry } from '../../src/environments/registry.ts'
import { createMapDispatcher } from '../../src/environments/dispatch.ts'
import { FakeBrowser } from '../helpers.ts'

const OBJECTIVE = { description: 'Complete the current page flow.' }

function decision(selected: string, provider = 'test'): DecisionResult {
  return { provider, mode: 'choice', selected, latencyMs: 1 }
}

describe('browser snapshot parsing', () => {
  it('parses title, url, main content, interactive items, and form fields', () => {
    const snapshot = parseBrowserSnapshot([
      'Title: Sign in',
      'URL: https://example.test/login',
      'Status: complete',
      '',
      'Main content:',
      'Welcome back. Please sign in.',
      '',
      'Interactive elements:',
      '  [3] button "Sign in"',
      '  [4] link "Forgot password?" → https://example.test/reset',
      '  [5] button "Sign in" [disabled]',
      '',
      'Form fields:',
      '  [7] Email (text) value="a@b.c" required',
      '  [8] Password (password) value="••••" required',
      '  [9] Remember (checkbox) checked=true',
    ].join('\n'))
    assert.equal(snapshot.title, 'Sign in')
    assert.equal(snapshot.url, 'https://example.test/login')
    assert.match(snapshot.main, /Welcome back/)
    assert.equal(snapshot.items.length, 3)
    assert.equal(snapshot.items[0]?.role, 'button')
    assert.equal(snapshot.items[0]?.name, 'Sign in')
    assert.equal(snapshot.items[1]?.href, 'https://example.test/reset')
    assert.equal(snapshot.items[2]?.disabled, true)
    assert.equal(snapshot.forms.length, 3)
    assert.equal(snapshot.forms[1]?.masked, true)
    assert.equal(snapshot.forms[2]?.checked, true)
    assert.equal(snapshot.unparsed.length, 0)
  })

  it('parses a delta snapshot and flags reassigned indices', () => {
    const snapshot = parseBrowserSnapshot([
      'Page change v3 (https://example.test/step2)',
      '',
      'Status: complete (element indices were reassigned; use the indices in this snapshot)',
      '',
      'Changed main content:',
      'Step two',
      '',
      'Changed interactive elements:',
      '  [1] button "Finish"',
    ].join('\n'))
    assert.equal(snapshot.url, 'https://example.test/step2')
    assert.equal(snapshot.reindexed, true)
    assert.equal(snapshot.items.length, 1)
  })

  it('keeps unrecognized lines visible instead of dropping them silently', () => {
    const snapshot = parseBrowserSnapshot('Title: x\nSomething entirely new: 42')
    assert.ok(snapshot.unparsed.some(line => line.includes('Something entirely new')))
  })

  it('detects a canvas-like page only when there is nothing to address', () => {
    assert.equal(looksCanvasLike({ main: '<canvas id="game">', mainChars: 18, items: [], forms: [], unparsed: [] }), true)
    assert.equal(looksCanvasLike({ main: 'A normal page that mentions canvas in a sentence.', mainChars: 50, items: [], forms: [], unparsed: [] }), false)
    assert.equal(
      looksCanvasLike({ main: '<canvas>', mainChars: 8, items: [{ index: 1, role: 'button', name: 'Play', disabled: false, outsideViewport: false }], forms: [], unparsed: [] }),
      false,
    )
  })
})

describe('browser observation', () => {
  it('observes a structured page and derives a finite candidate set', async () => {
    const page = new FakeBrowser({
      title: 'State A',
      main: 'Step one of the flow.',
      items: [
        { index: 1, role: 'button', name: 'Continue' },
        { index: 2, role: 'link', name: 'Cancel', href: 'https://example.test/cancel' },
      ],
    })
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: page.dispatcher() })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'ok')
    assert.equal(observation.source, 'browser')
    const request = adapter.buildDecisionRequest(observation, OBJECTIVE)
    assert.equal(request.mode, 'choice')
    assert.equal(request.candidates.length >= 2, true)
    assert.ok(request.candidates.some(candidate => /Continue/.test(candidate.description)))
    assert.ok(request.candidates.some(candidate => candidate.id === 'wait'))
    const state = request.state as Record<string, unknown>
    assert.equal(state.title, 'State A')
    assert.equal((state.interactive as unknown[]).length, 2)
  })

  it('reports unsupported when the session capability refuses the snapshot', async () => {
    const page = new FakeBrowser({ items: [{ index: 1, role: 'button', name: 'Go' }] })
    page.failWith = 'browser capability is not authorized'
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: page.dispatcher() })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'unsupported')
    assert.match(observation.reason ?? '', /not authorized/)
  })

  it('reports unsupported for a canvas-only page', async () => {
    const page = new FakeBrowser({ title: 'Game', main: '<canvas id="game"></canvas>', items: [] })
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: page.dispatcher() })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'unsupported')
    assert.match(observation.reason ?? '', /canvas|structured state/)
  })

  it('reports insufficient when the page has text but no controls', async () => {
    const page = new FakeBrowser({ main: 'A long paragraph of readable text with no controls at all, repeated for length. '.repeat(4) })
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: page.dispatcher() })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
  })

  it('never sends a screenshot: the required tool list is text-only', () => {
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: new FakeBrowser({}).dispatcher() })
    assert.ok(!adapter.requiredTools().some(name => /screenshot|image|vision/i.test(name)))
  })
})

describe('browser action mapping and execution', () => {
  it('maps a decision to a browser action and executes it', async () => {
    const page = new FakeBrowser({
      title: 'State A',
      items: [{ index: 7, role: 'button', name: 'Continue' }],
    })
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: page.dispatcher() })
    const observation = await adapter.observe()
    const request = adapter.buildDecisionRequest(observation, OBJECTIVE)
    const target = request.candidates.find(candidate => /Continue/.test(candidate.description))
    assert.ok(target !== undefined)
    const action = adapter.mapDecision(decision(target.id), observation)
    assert.equal(action.kind, 'click')
    assert.equal(action.target, 7)
    const result = await adapter.execute(action)
    assert.equal(result.ok, true)
    assert.deepEqual(page.clicks, [7])
  })

  it('refuses a decision that names an id the page never offered', async () => {
    const page = new FakeBrowser({ items: [{ index: 1, role: 'button', name: 'Continue' }] })
    const adapter = new BrowserEnvironmentAdapter({ dispatcher: page.dispatcher() })
    const observation = await adapter.observe()
    adapter.buildDecisionRequest(observation, OBJECTIVE)
    assert.throws(() => adapter.mapDecision(decision('click-launch-missiles-99'), observation), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'unknown_candidate'
    })
  })

  it('honours an explicit patch candidate set', async () => {
    const page = new FakeBrowser({ items: [{ index: 3, role: 'button', name: 'Anything' }] })
    const adapter = new BrowserEnvironmentAdapter({
      dispatcher: page.dispatcher(),
      config: {
        strategy: 'patch',
        candidates: [
          { id: 'submit', description: 'Submit the form', action: { kind: 'click', target: 3 } },
          { id: 'abort', description: 'Give up', action: { kind: 'press', target: 'Escape' } },
        ],
      },
    })
    const observation = await adapter.observe()
    const request = adapter.buildDecisionRequest(observation, OBJECTIVE)
    assert.deepEqual(request.candidates.map(candidate => candidate.id), ['submit', 'abort'])
    const action = adapter.mapDecision(decision('abort'), observation)
    assert.equal(action.kind, 'press')
    await adapter.execute(action)
    assert.deepEqual(page.presses, ['Escape'])
  })

  it('surfaces an execution failure as ok: false rather than throwing', async () => {
    const dispatcher = createMapDispatcher({
      browser_snapshot: () => ({ ok: true, text: 'Title: t\nURL: u\nInteractive elements:\n  [1] button "Go"' }),
      browser_click: () => ({ ok: false, text: '', error: 'element 1 is outside the viewport' }),
    })
    const adapter = new BrowserEnvironmentAdapter({ dispatcher })
    const observation = await adapter.observe()
    const request = adapter.buildDecisionRequest(observation, OBJECTIVE)
    const action = adapter.mapDecision(decision(request.candidates[0]?.id ?? 'wait'), observation)
    const result = await adapter.execute(action)
    assert.equal(result.ok, false)
    assert.match(result.message, /outside the viewport/)
  })

  it('marks a navigate candidate as a real navigation action', async () => {
    const page = new FakeBrowser({ items: [{ index: 1, role: 'button', name: 'Go' }] })
    const adapter = new BrowserEnvironmentAdapter({
      dispatcher: page.dispatcher(),
      config: { strategy: 'patch', candidates: [{ id: 'go-help', description: 'Open help', action: { kind: 'navigate', target: 'https://example.test/help' } }] },
    })
    const observation = await adapter.observe()
    const action = adapter.mapDecision(decision('go-help'), observation)
    assert.equal(action.kind, 'navigate')
    const result = await adapter.execute(action)
    assert.equal(result.ok, true)
  })
})

describe('computer AX tree parsing', () => {
  const TREE = [
    '[1] AXWindow "Download"',
    '  [2] AXStaticText "Download complete"',
    '  [3] AXButton "Open"',
    '  [4] AXButton "Show in Finder"',
    '  [5] AXButton "Close"',
    '  [6] AXGroup',
    '    [7] AXTextField "Search"',
  ].join('\n')

  it('parses nodes, roles, names, and depth', () => {
    const capture = parseAxTree(TREE)
    assert.equal(capture.kind, 'full')
    assert.equal(capture.nodes.length, 7)
    assert.equal(capture.nodes[0]?.role, 'AXWindow')
    assert.equal(capture.nodes[0]?.depth, 0)
    assert.equal(capture.nodes[6]?.depth, 2)
    assert.equal(capture.nodes[2]?.name, 'Open')
  })

  it('recognizes a diff capture', () => {
    const capture = parseAxTree([
      '--- diff since last capture ---',
      '[1] AXWindow "Download"',
      '+ [3] AXButton "Open" added',
      '- [8] AXButton "Cancel" removed',
    ].join('\n'))
    assert.equal(capture.kind, 'diff')
    assert.equal(capture.nodes.filter(node => node.added).length, 1)
    assert.equal(capture.nodes.filter(node => node.removed).length, 1)
  })

  it('flags truncation from the provider marker', () => {
    assert.equal(parseAxTree('[1] AXWindow "x"\n…(truncated at 1200 nodes)').truncated, true)
  })
})

describe('computer observation', () => {
  function seamWith(text: string, options: { truncated?: boolean; app?: string } = {}) {
    return {
      listApps: () => Promise.resolve('Download'),
      getAppState: () => Promise.resolve({ app: options.app ?? 'Download', text, truncated: options.truncated ?? false, screenshot: { data: Buffer.from('pixels'), mediaType: 'image/jpeg' as const, width: 1, height: 1 } }),
      click: () => Promise.resolve('clicked'),
      typeText: () => Promise.resolve('typed'),
      pressKey: () => Promise.resolve('pressed'),
      scroll: () => Promise.resolve('scrolled'),
      setValue: () => Promise.resolve('set'),
      selectText: () => Promise.resolve('selected'),
    }
  }

  it('observes the accessibility tree and ignores the screenshot', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: seamWith('[1] AXWindow "Download"\n  [3] AXButton "Open"\n  [4] AXButton "Close"'),
      config: { app: 'Download' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'ok')
    const request = adapter.buildDecisionRequest(observation, { description: 'Open the downloaded file.' })
    assert.equal(request.candidates.length >= 2, true)
    assert.ok(request.candidates.some(candidate => /Open/.test(candidate.description)))
    const treeText = JSON.stringify(request)
    assert.ok(!treeText.includes('pixels'), 'the screenshot must never enter the decision state')
  })

  it('reports insufficient when the tree is only anonymous groups', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: seamWith('[1] AXGroup\n[2] AXGroup\n[3] AXGroup'),
      config: { app: 'Weird' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
    assert.match(observation.reason ?? '', /anonymous groups/)
  })

  it('reports insufficient for a diff capture', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: seamWith('--- diff ---\n[1] AXWindow "x"\n+ [2] AXButton "Open" added'),
      config: { app: 'Download' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
  })

  it('reports insufficient when no app is configured', async () => {
    const adapter = new ComputerEnvironmentAdapter({ seam: seamWith('[1] AXButton "Open"') })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
    assert.match(observation.reason ?? '', /No target app/)
  })

  it('gives up on a capture that never answers, instead of hanging', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        ...seamWith('[1] AXButton "Open"'),
        getAppState: () => new Promise(() => undefined),
      },
      config: { app: 'Wedged', captureTimeoutMs: 20 },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'unsupported')
    assert.match(observation.reason ?? '', /did not answer within 20ms/)
  })

  it('treats a capture that answers with nothing as a failure', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        ...seamWith('[1] AXButton "Open"'),
        getAppState: () => Promise.resolve(undefined as never),
      },
      config: { app: 'Empty' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'unsupported')
    assert.match(observation.reason ?? '', /returned no state/)
  })

  it('reports unsupported when the capability refuses the capture', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        ...seamWith('[1] AXButton "Open"'),
        getAppState: () => Promise.reject(new Error('Accessibility permission is required')),
      },
      config: { app: 'Download' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'unsupported')
    assert.match(observation.reason ?? '', /Accessibility permission/)
  })

  it('maps a decision to an element-indexed click and executes it', async () => {
    const calls: Record<string, unknown>[] = []
    const seam = {
      ...seamWith('[1] AXWindow "Download"\n  [3] AXButton "Open"\n  [4] AXButton "Close"'),
      click: (request: Record<string, unknown>) => {
        calls.push(request)
        return Promise.resolve('clicked')
      },
    }
    const adapter = new ComputerEnvironmentAdapter({ seam, config: { app: 'Download' } })
    const observation = await adapter.observe()
    const request = adapter.buildDecisionRequest(observation, { description: 'Open the downloaded file.' })
    const open = request.candidates.find(candidate => /Open/.test(candidate.description))
    assert.ok(open !== undefined)
    const action = adapter.mapDecision(decision(open.id), observation)
    assert.equal(action.kind, 'click')
    assert.equal(action.target, 3)
    assert.equal((await adapter.execute(action)).ok, true)
    assert.equal(calls[0]?.elementIndex, 3)
    assert.equal(calls[0]?.app, 'Download')
  })

  it('falls back to the tool path when no seam is mounted', async () => {
    const seen: Record<string, unknown>[] = []
    const dispatcher = createMapDispatcher({
      computer_use_get_app_state: () => ({ ok: true, text: '[1] AXWindow "Download"\n  [3] AXButton "Open"' }),
      computer_use_click: (args) => {
        seen.push(args)
        return { ok: true, text: 'clicked' }
      },
    })
    const adapter = new ComputerEnvironmentAdapter({ dispatcher, config: { app: 'Download' } })
    const observation = await adapter.observe()
    const request = adapter.buildDecisionRequest(observation, { description: 'Open it.' })
    const action = adapter.mapDecision(decision(request.candidates[0]?.id ?? 'x'), observation)
    await adapter.execute(action)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.app, 'Download')
  })
})

describe('custom environment', () => {
  it('drives a structured state through the protocol', async () => {
    const executed: string[] = []
    const adapter = new CustomEnvironmentAdapter<{ score: number; health: number; enemyHealth: number; availableActions: string[] }>({
      id: 'battle',
      observe: () => ({ score: 100, health: 60, enemyHealth: 30, availableActions: ['attack', 'defend', 'heal'] }),
      candidates: state => state.availableActions.map(action => ({ id: action, description: `Perform ${action}` })),
      execute: (candidate) => {
        executed.push(candidate.id)
        return { ok: true, message: `ran ${candidate.id}` }
      },
      summarize: state => `hp ${state.health} vs ${state.enemyHealth}`,
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'ok')
    assert.equal(observation.summary, 'hp 60 vs 30')
    const request = adapter.buildDecisionRequest(observation, { description: 'Win the fight.' })
    assert.deepEqual(request.candidates.map(candidate => candidate.id), ['attack', 'defend', 'heal'])
    const action = adapter.mapDecision(decision('heal'), observation)
    assert.equal(action.kind, 'custom')
    assert.equal((await adapter.execute(action)).ok, true)
    assert.deepEqual(executed, ['heal'])
  })

  it('reports insufficient when the environment has no structured state', async () => {
    const adapter = new CustomEnvironmentAdapter<undefined>({
      id: 'empty',
      observe: () => undefined,
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
  })

  it('reports error when observe throws', async () => {
    const adapter = new CustomEnvironmentAdapter({
      id: 'broken',
      observe: () => {
        throw new Error('device offline')
      },
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'error')
    assert.match(observation.reason ?? '', /device offline/)
  })

  it('drops candidates whose availability predicate is false', async () => {
    const adapter = new CustomEnvironmentAdapter<{ canHeal: boolean }>({
      id: 'gated',
      observe: () => ({ canHeal: false }),
      candidates: [
        { id: 'attack', description: 'Attack' },
        { id: 'heal', description: 'Heal', available: state => state.canHeal },
      ],
      execute: () => ({ ok: true }),
    })
    const observation = await adapter.observe()
    const request = adapter.buildDecisionRequest(observation, { description: 'Win.' })
    assert.deepEqual(request.candidates.map(candidate => candidate.id), ['attack'])
  })

  it('refuses a decision naming a candidate that is not available now', async () => {
    const adapter = new CustomEnvironmentAdapter<{ canHeal: boolean }>({
      id: 'gated',
      observe: () => ({ canHeal: false }),
      candidates: [
        { id: 'attack', description: 'Attack' },
        { id: 'heal', description: 'Heal', available: state => state.canHeal },
      ],
      execute: () => ({ ok: true }),
    })
    const observation = await adapter.observe()
    adapter.buildDecisionRequest(observation, { description: 'Win.' })
    assert.throws(() => adapter.mapDecision(decision('heal'), observation), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'unknown_candidate'
    })
  })

  it('marks a risky candidate so the runtime can refuse it', async () => {
    const adapter = new CustomEnvironmentAdapter({
      id: 'danger',
      observe: () => ({ ready: true }),
      candidates: [{ id: 'delete-everything', description: 'Delete', risky: true }],
      execute: () => ({ ok: true }),
    })
    const observation = await adapter.observe()
    adapter.buildDecisionRequest(observation, { description: 'Clean up.' })
    assert.equal(adapter.mapDecision(decision('delete-everything'), observation).risky, true)
  })

  it('wraps a thrown execution error as action_execution_failed', async () => {
    const adapter = new CustomEnvironmentAdapter({
      id: 'throws',
      observe: () => ({ ok: true }),
      candidates: [{ id: 'go', description: 'Go' }],
      execute: () => {
        throw new Error('actuator jammed')
      },
    })
    const observation = await adapter.observe()
    adapter.buildDecisionRequest(observation, { description: 'Go.' })
    const action = adapter.mapDecision(decision('go'), observation)
    await assert.rejects(adapter.execute(action), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'action_execution_failed'
    })
  })
})

describe('environment registry', () => {
  it('registers, requires, lists, and disposes adapters', async () => {
    const registry = new EnvironmentRegistry()
    const adapter = new CustomEnvironmentAdapter({
      id: 'one',
      observe: () => ({ a: 1 }),
      candidates: [{ id: 'x', description: 'X' }],
      execute: () => ({ ok: true }),
    })
    const dispose = registry.register(adapter)
    assert.ok(registry.has('one'))
    assert.equal(registry.require('one').id, 'one')
    assert.equal(registry.ids().length, 1)
    assert.equal(registry.list()[0]?.id, 'one')
    dispose()
    assert.equal(registry.has('one'), false)
  })

  it('rejects a duplicate id and an adapter missing a required method', () => {
    const registry = new EnvironmentRegistry()
    const adapter = new CustomEnvironmentAdapter({
      id: 'one',
      observe: () => ({ a: 1 }),
      candidates: [{ id: 'x', description: 'X' }],
      execute: () => ({ ok: true }),
    })
    registry.register(adapter)
    assert.throws(() => registry.register(adapter), (error: unknown) => error instanceof DecisionError && error.code === 'invalid_request')
    registry.register(adapter, { replace: true })
    assert.throws(
      () => registry.register({ id: 'broken', source: 'custom' } as never),
      (error: unknown) => error instanceof DecisionError && error.code === 'invalid_request',
    )
  })

  it('fails with environment_unknown for an unregistered id', () => {
    const registry = new EnvironmentRegistry()
    assert.throws(() => registry.require('nope'), (error: unknown) => error instanceof DecisionError && error.code === 'environment_unknown')
  })
})
