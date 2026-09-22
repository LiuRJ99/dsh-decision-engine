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
import { isAddressable, isPassive, isSettable, labelOf, parseAxTree } from '../../src/environments/computer/ax-tree.ts'
import { CustomEnvironmentAdapter } from '../../src/environments/custom/adapter.ts'
import { EnvironmentRegistry } from '../../src/environments/registry.ts'
import { createMapDispatcher } from '../../src/environments/dispatch.ts'
import { FakeBrowser } from '../helpers.ts'

/**
 * A real daemon capture, reduced to the fields under test. Indices are the
 * addressing keys the action tools use, so they are kept verbatim (note the gap
 * between 3 and 7: the daemon numbers every node depth-first).
 */
function realTree(buttonTitles: string[]): string {
  const lines = ['App=com.apple.TextEdit (pid 1)', 'Window: "Downloads", App: 文本编辑.']
  lines.push('0 standard window Downloads ID: MainWindow Secondary Actions: Raise')
  lines.push('\t1 split group')
  let index = 2
  for (const title of buttonTitles) {
    lines.push(`\t\t${index} button ${title}`)
    index += 1
  }
  lines.push(`\t\t${index} static text Value: Download complete`)
  return lines.join('\n')
}

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
  /**
   * A verbatim slice of a real capture from the daemon
   * (`computer_use_get_app_state` on Finder, reduced here). Every shape the
   * parser has to handle appears in it: a tab-indented depth, a depth-first
   * index, an unquoted multi-word role, an unquoted title, `Description:`,
   * `(traits)` immediately before `Value:`, `ID:`, and `Secondary Actions:`.
   */
  const REAL_TREE = [
    'App=com.apple.finder (pid 757)',
    'Window: "dsh-work", App: 访达.',
    '0 standard window dsh-work ID: FinderWindow Secondary Actions: Raise',
    '\t1 split group',
    '\t\t2 scroll area Secondary Actions: Scroll Left By Page, Scroll Right By Page',
    '\t\t\t3 outline Description: 边栏 Secondary Actions: Show Menu',
    '\t\t\t\t4 row Secondary Actions: Show Default U I, Show Alternate U I',
    '\t\t\t\t\t5 cell Secondary Actions: Open',
    '\t\t\t\t\t\t6 static text Value: 最近使用',
    '\t\t\t\t\t\t7 image Description: 时钟',
    '\t\t\t\t\t\t50 button 推出 Description: 推出 (disabled)',
    '\t\t\t\t\t\t60 text field Value: search text (settable, string) Help: type to filter ID: searchField',
  ].join('\n')

  it('parses the real daemon format', () => {
    const capture = parseAxTree(REAL_TREE)
    assert.equal(capture.kind, 'full')
    assert.equal(capture.app, 'com.apple.finder')
    assert.equal(capture.window, 'dsh-work')
    assert.equal(capture.nodes.length, 10)
    assert.deepEqual(capture.unparsed, [])
  })

  it('splits a multi-word role from an unquoted title', () => {
    const capture = parseAxTree(REAL_TREE)
    const window = capture.nodes[0]
    assert.equal(window?.role, 'standard window')
    assert.equal(window?.title, 'dsh-work')
    assert.deepEqual(window?.secondaryActions, ['Raise'])
    assert.equal(window?.identifier, 'FinderWindow')

    const button = capture.nodes.find(node => node.index === 50)
    assert.equal(button?.role, 'button')
    assert.equal(button?.title, '推出')
    // The daemon renders the disabled trait inside the description for a button,
    // and the description keeps it verbatim while the trait is also recorded.
    assert.equal(button?.description, '推出 (disabled)')
    assert.equal(button?.disabled, true, 'the (disabled) trait must be read')
  })

  it('reads Value only through the parenthesized traits anchor', () => {
    const capture = parseAxTree(REAL_TREE)
    const cell = capture.nodes.find(node => node.index === 5)
    assert.equal(cell?.role, 'cell')
    assert.equal(cell?.value, undefined, 'a cell renders no Value field')

    const text = capture.nodes.find(node => node.index === 6)
    assert.equal(text?.role, 'static text')
    assert.equal(text?.value, '最近使用')

    const field = capture.nodes.find(node => node.index === 60)
    assert.equal(field?.role, 'text field')
    assert.equal(field?.value, 'search text')
    assert.equal(field?.settable, true, 'the (settable, string) trait must be read')
    assert.equal(field?.help, 'type to filter')
    assert.equal(field?.identifier, 'searchField')
  })

  it('parses a multi-word description without swallowing later fields', () => {
    const capture = parseAxTree('0 image dsh_workflow、21个项目 Description: dsh_workflow、21个项目 ID: dsh_workflow Secondary Actions: Open, Show Menu')
    const node = capture.nodes[0]
    assert.equal(node?.role, 'image')
    assert.equal(node?.title, 'dsh_workflow、21个项目')
    assert.equal(node?.description, 'dsh_workflow、21个项目')
    assert.equal(node?.identifier, 'dsh_workflow')
    assert.deepEqual(node?.secondaryActions, ['Open', 'Show Menu'])
  })

  it('keeps the depth-first index verbatim, including gaps', () => {
    const capture = parseAxTree('0 button A\n\t\t9 button B')
    assert.deepEqual(capture.nodes.map(node => node.index), [0, 9])
    assert.deepEqual(capture.nodes.map(node => node.depth), [0, 2])
  })

  it('reports everything addressable, and why', () => {
    const capture = parseAxTree(REAL_TREE)
    const addressable = capture.nodes.filter(node => isAddressable(node))
    // The window (Raise), the scroll area, the outline, the row, the cell, the
    // image with a description but no actions... and NOT the disabled button,
    // and NOT the static text without a settable value.
    assert.deepEqual(addressable.map(node => node.index), [0, 2, 3, 4, 5, 7, 60])
    assert.equal(isAddressable(capture.nodes.find(node => node.index === 50) as never), false, 'a disabled control is not addressable')
    assert.equal(isAddressable(capture.nodes.find(node => node.index === 6) as never), false, 'read-only text is not addressable')
    assert.equal(isSettable(capture.nodes.find(node => node.index === 60) as never), true)
    assert.equal(isPassive(capture.nodes.find(node => node.index === 6) as never), true)
  })

  it('labels a node from its best available field', () => {
    const capture = parseAxTree(REAL_TREE)
    const window = capture.nodes[0]
    assert.equal(labelOf(window as never), 'dsh-work', 'title wins')
    const image = capture.nodes.find(node => node.index === 7)
    assert.equal(labelOf(image as never), '时钟', 'description is the label for an icon')
    const cell = capture.nodes.find(node => node.index === 5)
    assert.equal(labelOf(cell as never), 'cell 5', 'last resort names the role and index, never empty')
  })

  it('recognizes a diff capture', () => {
    const capture = parseAxTree([
      '--- diff since last capture ---',
      '0 standard window x',
      '+ 3 button Open',
      '- 8 button Cancel',
    ].join('\n'))
    assert.equal(capture.kind, 'diff')
    assert.equal(capture.nodes.filter(node => node.added).length, 1)
    assert.equal(capture.nodes.filter(node => node.removed).length, 1)
  })

  it('flags truncation from the provider marker', () => {
    assert.equal(parseAxTree('0 button x\n... (accessibility tree truncated at the capture byte limit)').truncated, true)
  })

  it('falls back to the first word for a role outside the vocabulary', () => {
    const capture = parseAxTree('4 some new role title here')
    assert.equal(capture.nodes[0]?.role, 'some')
    assert.equal(capture.nodes[0]?.title, 'new role title here')
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
      seam: seamWith(realTree(['Open', 'Close'])),
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
      seam: seamWith(['App=x (pid 1)', 'Window: "w", App: x.', '0 group', '\t1 group', '\t2 group'].join('\n')),
      config: { app: 'Weird' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
    assert.match(observation.reason ?? '', /anonymous groups/)
  })

  it('reports insufficient for a diff capture', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: seamWith('--- diff since last capture ---\n0 standard window x\n+ 2 button Open'),
      config: { app: 'Download' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
  })

  it('reports insufficient when no app is configured', async () => {
    const adapter = new ComputerEnvironmentAdapter({ seam: seamWith(realTree(['Open'])) })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
    assert.match(observation.reason ?? '', /No target app/)
  })

  it('gives up on a capture that never answers, instead of hanging', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        ...seamWith(realTree(['Open'])),
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
        ...seamWith(realTree(['Open'])),
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
        ...seamWith(realTree(['Open'])),
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
      ...seamWith(realTree(['Open', 'Close'])),
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
    // The index travels verbatim out of the real tree: "Open" is the first
    // button, at index 2.
    assert.equal(action.target, 2)
    assert.equal((await adapter.execute(action)).ok, true)
    assert.equal(calls[0]?.elementIndex, 2)
    assert.equal(calls[0]?.app, 'Download')
  })

  it('falls back to the tool path when no seam is mounted', async () => {
    const seen: Record<string, unknown>[] = []
    const dispatcher = createMapDispatcher({
      computer_use_get_app_state: () => ({ ok: true, text: realTree(['Open']) }),
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

describe('computer diff merging', () => {
  function seamText(text: string) {
    return {
      listApps: () => Promise.resolve('x'),
      getAppState: () => Promise.resolve({ app: 'x', text, truncated: false, screenshot: null }),
      click: () => Promise.resolve(),
      typeText: () => Promise.resolve(),
      pressKey: () => Promise.resolve(),
      scroll: () => Promise.resolve(),
      setValue: () => Promise.resolve(),
    }
  }

  const FULL = [
    'App=com.apple.TextEdit (pid 1)',
    'Window: "doc", App: 文本编辑.',
    '0 standard window doc',
    '\t1 button Save',
    '\t2 button Close',
    '\t3 static text Value: hello',
  ].join('\n')

  it('merges a diff onto the previous full capture instead of refusing it', async () => {
    let capture = 0
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        ...seamText(FULL),
        getAppState: () => {
          capture += 1
          if (capture === 1) return Promise.resolve({ app: 'x', text: FULL, truncated: false, screenshot: null })
          return Promise.resolve({
            app: 'x',
            truncated: false,
            screenshot: null,
            // The daemon's real diff shape: an announcement, `+`/`~` lines in
            // full, and removals collapsed into one id range.
            text: [
              'App=com.apple.TextEdit (pid 1)',
              'The following is a diff from the previous accessibility tree',
              '~ 3 static text Value: world',
              '+ 4 button Undo',
              'Removed element IDs: 2',
            ].join('\n'),
          })
        },
      },
      config: { app: 'x' },
    })

    const first = await adapter.observe()
    assert.equal(first.status, 'ok')
    const firstRequest = adapter.buildDecisionRequest(first, { description: 'Save the file.' })
    assert.ok(firstRequest.candidates.some(candidate => /Save/.test(candidate.description)))

    const second = await adapter.observe()
    assert.equal(second.status, 'ok', 'a diff must merge, not refuse')
    const nodes = (second.state as { ax: { nodes: { index: number; value?: string }[] } }).ax.nodes
    assert.deepEqual(nodes.map(node => node.index), [0, 1, 3, 4], 'close (2) is gone, undo (4) is added')
    assert.equal(nodes.find(node => node.index === 3)?.value, 'world', 'the changed line was replaced')
    const secondRequest = adapter.buildDecisionRequest(second, { description: 'Undo the change.' })
    assert.ok(secondRequest.candidates.some(candidate => /Undo/.test(candidate.description)))
    assert.ok(!secondRequest.candidates.some(candidate => /Close/.test(candidate.description)), 'a removed element is not offered')
  })

  it('treats the unchanged announcement as the same tree', async () => {
    let capture = 0
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        ...seamText(FULL),
        getAppState: () => {
          capture += 1
          return Promise.resolve({
            app: 'x',
            truncated: false,
            screenshot: null,
            text: capture === 1
              ? FULL
              : 'App=com.apple.TextEdit (pid 1)\nThere has been no change in the accessibility tree for the previous capture.',
          })
        },
      },
      config: { app: 'x' },
    })
    assert.equal((await adapter.observe()).status, 'ok')
    const second = await adapter.observe()
    assert.equal(second.status, 'ok')
    const request = adapter.buildDecisionRequest(second, { description: 'Save.' })
    assert.ok(request.candidates.some(candidate => /Save/.test(candidate.description)))
  })

  it('still refuses a diff when there is no full capture to merge onto', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: seamText('The following is a diff from the previous accessibility tree\n~ 3 static text Value: world'),
      config: { app: 'x' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'insufficient')
    assert.match(observation.reason ?? '', /no full capture/)
  })

  it('does not mistake ordinary text for a diff', async () => {
    // The regression: a Finder-style value containing the word "changed" must
    // not make the whole capture look like a diff.
    const adapter = new ComputerEnvironmentAdapter({
      seam: seamText([
        'App=com.apple.finder (pid 1)',
        'Window: "w", App: 访达.',
        '0 standard window w',
        '\t1 static text Value: 3 items changed',
        '\t2 button Open',
      ].join('\n')),
      config: { app: 'x' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'ok')
    const request = adapter.buildDecisionRequest(observation, { description: 'Open it.' })
    assert.ok(request.candidates.some(candidate => /Open/.test(candidate.description)))
  })
})
