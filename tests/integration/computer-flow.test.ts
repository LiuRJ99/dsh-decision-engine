/**
 * E. Computer integration test — the accessibility-tree path, end to end.
 *
 * ```text
 * AX tree
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
 * computer_use_<action>
 * ```
 *
 * Two transports are covered because the adapter supports both: the in-process
 * `ctx.computer` seam, and the registered `computer_use_*` tool family. Both
 * are driven here with deterministic stand-ins, so the test runs anywhere.
 *
 * Driving a real desktop is deliberately NOT part of this suite: it needs
 * Accessibility permission, the user's session unlocked with `/computer-use`,
 * and an app the user is not using. `examples/verify-real-computer.mjs` is the
 * manual version, and it prints what it would do before doing it.
 *
 * @module dsh-decision-engine/tests/integration/computer-flow.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionProviderRegistry } from '../../src/core/provider-registry.ts'
import { EnvironmentRegistry } from '../../src/environments/registry.ts'
import { ComputerEnvironmentAdapter, type ComputerSeam, type ComputerSeamState } from '../../src/environments/computer/adapter.ts'
import { createMapDispatcher } from '../../src/environments/dispatch.ts'
import { DecisionRuntime } from '../../src/runtime/runner.ts'
import { ScriptedProvider } from '../helpers.ts'

/**
 * A fake Download dialog: the accessibility tree the Codex-style capture
 * produces, plus the state transitions clicking each button causes.
 */
class FakeDownloadDialog {
  readonly calls: { operation: string; args: Record<string, unknown> }[] = []
  /** Set when the fake capture should include a screenshot payload. */
  readonly screenshot = { data: Buffer.from('JPEG-PIXELS-NEVER-READ'), mediaType: 'image/jpeg' as const, width: 800, height: 600 }
  #open = true

  /** Close the dialog, as the real Click on "Close" would. */
  close(): void {
    this.#open = false
  }

  /** The serialized AX tree for the current state. */
  tree(): string {
    return this.#open
      ? [
          '[1] AXWindow "Download"',
          '  [2] AXStaticText "Download complete"',
          '  [3] AXButton "Open"',
          '  [4] AXButton "Show in Finder"',
          '  [5] AXButton "Close"',
        ].join('\n')
      : [
          '[1] AXWindow "Download"',
          '  [2] AXStaticText "No recent downloads"',
        ].join('\n')
  }

  seam(): ComputerSeam {
    return {
      listApps: () => Promise.resolve('Download'),
      getAppState: (request): Promise<ComputerSeamState> => {
        this.calls.push({ operation: 'getAppState', args: request as Record<string, unknown> })
        return Promise.resolve({ app: 'Download', text: this.tree(), truncated: false, screenshot: this.screenshot })
      },
      click: (request) => {
        this.calls.push({ operation: 'click', args: request as Record<string, unknown> })
        if (Number((request as { elementIndex?: unknown }).elementIndex) === 5) this.#open = false
        return Promise.resolve('clicked')
      },
      typeText: (request) => {
        this.calls.push({ operation: 'typeText', args: request as Record<string, unknown> })
        return Promise.resolve('typed')
      },
      pressKey: (request) => {
        this.calls.push({ operation: 'pressKey', args: request as Record<string, unknown> })
        return Promise.resolve('pressed')
      },
      scroll: (request) => {
        this.calls.push({ operation: 'scroll', args: request as Record<string, unknown> })
        return Promise.resolve('scrolled')
      },
      setValue: (request) => {
        this.calls.push({ operation: 'setValue', args: request as Record<string, unknown> })
        return Promise.resolve('set')
      },
    }
  }
}

/** A provider that behaves like a small model reading the AX node names. */
function dialogProvider(): ScriptedProvider {
  return new ScriptedProvider({
    id: 'dialog-model',
    capabilities: ['choice', 'ranking', 'score', 'classification'],
    plan: (request) => {
      const preferred = /open the downloaded file/i.test(request.objective ?? '') ? /Open/i : /Close/i
      const candidate = request.candidates.find(entry => preferred.test(entry.description)) ?? request.candidates[0]
      return {
        provider: 'dialog-model',
        mode: 'choice',
        ...candidate === undefined ? {} : { selected: candidate.id },
        confidence: 0.86,
        latencyMs: 1,
      }
    },
  })
}

function buildDialog(options: { transport: 'seam' | 'tools' }) {
  const dialog = new FakeDownloadDialog()
  const toolCalls: { name: string; args: Record<string, unknown> }[] = []
  const toolDispatcher = createMapDispatcher({
    computer_use_get_app_state: (args) => {
      toolCalls.push({ name: 'computer_use_get_app_state', args })
      return { ok: true, text: dialog.tree() }
    },
    computer_use_click: (args) => {
      toolCalls.push({ name: 'computer_use_click', args })
      if (Number(args.elementIndex) === 5) dialog.close()
      return { ok: true, text: 'clicked' }
    },
  })
  // The private field is only touched through the seam in the 'seam' transport.
  const adapter = new ComputerEnvironmentAdapter({
    ...options.transport === 'seam' ? { seam: dialog.seam() } : { dispatcher: toolDispatcher },
    config: { app: 'Download' },
  })
  const environments = new EnvironmentRegistry()
  environments.register(adapter)
  const registry = new DecisionProviderRegistry()
  const provider = dialogProvider()
  registry.register(provider, { enabled: true, config: {} })
  const engine = new DecisionEngine({ defaultProviderId: 'dialog-model' }, registry)
  const runtime = new DecisionRuntime(engine, { environments, config: { maxSteps: 4, repeatedDecisionLimit: 3, noProgressLimit: 4 } })
  return { dialog, adapter, runtime, provider, toolCalls }
}

describe('computer flow over the ctx.computer seam', () => {
  it('decides which button to press without executing it', async () => {
    const { runtime, dialog } = buildDialog({ transport: 'seam' })
    const outcome = await runtime.run({ environment: 'computer', objective: { description: 'Open the downloaded file.' } })
    assert.equal(outcome.status, 'decided')
    assert.equal(outcome.action?.kind, 'click')
    assert.equal(outcome.action?.target, 3)
    assert.deepEqual(dialog.calls.filter(call => call.operation === 'click'), [])
  })

  it('executes the click on the AX element index', async () => {
    const { runtime, dialog } = buildDialog({ transport: 'seam' })
    const outcome = await runtime.run({
      environment: 'computer',
      objective: { description: 'Open the downloaded file.' },
      mode: 'single-step',
    })
    assert.equal(outcome.status, 'executed')
    const click = dialog.calls.find(call => call.operation === 'click')
    assert.equal(click?.args.elementIndex, 3)
    assert.equal(click?.args.app, 'Download')
  })

  it('never reads the screenshot the capture returns', async () => {
    const { runtime, provider } = buildDialog({ transport: 'seam' })
    await runtime.run({ environment: 'computer', objective: { description: 'Open the downloaded file.' }, mode: 'single-step' })
    const serialized = JSON.stringify(provider.calls)
    assert.ok(!serialized.includes('JPEG-PIXELS-NEVER-READ'), 'the screenshot must never reach the decision layer')
    assert.ok(!serialized.includes('screenshot'), 'the screenshot field must not be referenced')
  })

  it('escalates rather than guessing when the tree becomes anonymous groups', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        listApps: () => Promise.resolve(''),
        getAppState: () => Promise.resolve({ app: 'Weird', text: '[1] AXGroup\n[2] AXGroup\n[3] AXGroup', truncated: false, screenshot: null }),
        click: () => Promise.resolve(),
        typeText: () => Promise.resolve(),
        pressKey: () => Promise.resolve(),
        scroll: () => Promise.resolve(),
        setValue: () => Promise.resolve(),
      },
      config: { app: 'Weird' },
    })
    const environments = new EnvironmentRegistry()
    environments.register(adapter)
    const registry = new DecisionProviderRegistry()
    registry.register(dialogProvider(), { enabled: true, config: {} })
    const engine = new DecisionEngine({ defaultProviderId: 'dialog-model' }, registry)
    const runtime = new DecisionRuntime(engine, { environments })
    const outcome = await runtime.run({ environment: 'computer', objective: { description: 'Do something.' }, mode: 'bounded-loop' })
    assert.equal(outcome.status, 'needs_escalation')
    assert.equal(outcome.escalation?.reason, 'insufficient_observation')
    assert.match(outcome.escalation?.guidance ?? '', /instead of guessing/i)
  })

  it('escalates when Accessibility permission is missing', async () => {
    const adapter = new ComputerEnvironmentAdapter({
      seam: {
        listApps: () => Promise.resolve(''),
        getAppState: () => Promise.reject(new Error('Accessibility permission is required')),
        click: () => Promise.resolve(),
        typeText: () => Promise.resolve(),
        pressKey: () => Promise.resolve(),
        scroll: () => Promise.resolve(),
        setValue: () => Promise.resolve(),
      },
      config: { app: 'Download' },
    })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'unsupported')
    assert.match(observation.reason ?? '', /Accessibility permission/)
  })
})

describe('computer flow over the registered tool family', () => {
  it('dispatches computer_use_* tools by name, like any other tool', async () => {
    const { runtime, toolCalls } = buildDialog({ transport: 'tools' })
    const outcome = await runtime.run({
      environment: 'computer',
      objective: { description: 'Open the downloaded file.' },
      mode: 'single-step',
    })
    assert.equal(outcome.status, 'executed')
    assert.deepEqual(toolCalls.map(call => call.name), ['computer_use_get_app_state', 'computer_use_click'])
    assert.equal(toolCalls[1]?.args.elementIndex, 3)
  })

  it('maps a tool refusal to an escalation instead of retrying blindly', async () => {
    const dispatcher = createMapDispatcher({
      computer_use_get_app_state: () => ({ ok: true, text: '[1] AXWindow "Download"\n  [3] AXButton "Open"' }),
      computer_use_click: () => ({ ok: false, text: '', error: 'computer_use_click: the computer capability is not authorized in this session' }),
    })
    const adapter = new ComputerEnvironmentAdapter({ dispatcher, config: { app: 'Download' } })
    const environments = new EnvironmentRegistry()
    environments.register(adapter)
    const registry = new DecisionProviderRegistry()
    registry.register(dialogProvider(), { enabled: true, config: {} })
    const engine = new DecisionEngine({ defaultProviderId: 'dialog-model' }, registry)
    const runtime = new DecisionRuntime(engine, { environments })
    const outcome = await runtime.run({
      environment: 'computer',
      objective: { description: 'Open the downloaded file.' },
      mode: 'single-step',
    })
    assert.equal(outcome.status, 'needs_escalation')
    assert.equal(outcome.escalation?.reason, 'action_execution_failed')
    assert.match(JSON.stringify(outcome.escalation?.details), /not authorized/)
  })
})

describe('computer transport equivalence', () => {
  it('produces the same decision and the same mapped action on both transports', async () => {
    const viaSeam = buildDialog({ transport: 'seam' })
    const viaTools = buildDialog({ transport: 'tools' })
    const first = await viaSeam.runtime.run({ environment: 'computer', objective: { description: 'Open the downloaded file.' } })
    const second = await viaTools.runtime.run({ environment: 'computer', objective: { description: 'Open the downloaded file.' } })
    assert.equal(first.decision?.selected, second.decision?.selected)
    assert.equal(first.action?.kind, second.action?.kind)
    assert.equal(first.action?.target, second.action?.target)
  })
})
