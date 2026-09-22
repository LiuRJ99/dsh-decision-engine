/**
 * Shared test doubles: providers, environments, and a tool dispatcher.
 *
 * These live in one place so every test drives the same protocol the way a real
 * provider would, and so a fake provider can never accidentally be the only
 * place a behavior is exercised.
 *
 * @module dsh-decision-engine/tests/helpers
 */

import { createMapDispatcher, type ToolCallResult } from '../src/environments/dispatch.ts'
import { okObservation, type CustomEnvironmentSpec } from '../src/environments/types.ts'
import { CustomEnvironmentAdapter } from '../src/environments/custom/adapter.ts'
import type { DecisionCapability, DecisionContext, DecisionProvider, DecisionRequest, DecisionResult, ProviderHealth } from '../src/core/types.ts'

/** A provider that answers from a scripted function. */
export class ScriptedProvider implements DecisionProvider {
  readonly id: string
  readonly capabilities: readonly DecisionCapability[]
  readonly calls: DecisionRequest[] = []
  readonly contexts: (DecisionContext | undefined)[] = []
  #plan: (request: DecisionRequest, context: DecisionContext | undefined, callIndex: number) => Promise<DecisionResult> | DecisionResult

  constructor(options: {
    id?: string
    capabilities?: DecisionCapability[]
    plan: (request: DecisionRequest, context: DecisionContext | undefined, callIndex: number) => Promise<DecisionResult> | DecisionResult
  }) {
    this.id = options.id ?? 'scripted'
    this.capabilities = options.capabilities ?? ['choice', 'ranking', 'score', 'classification']
    this.#plan = options.plan
  }

  async decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult> {
    const callIndex = this.calls.length
    this.calls.push(request)
    this.contexts.push(context)
    return this.#plan(request, context, callIndex)
  }
}

/** A provider that always picks the same candidate id. */
export function constantProvider(selected: string, options: { id?: string; confidence?: number; capabilities?: DecisionCapability[] } = {}): ScriptedProvider {
  return new ScriptedProvider({
    ...options.id === undefined ? {} : { id: options.id },
    ...options.capabilities === undefined ? {} : { capabilities: options.capabilities },
    plan: () => ({
      provider: options.id ?? 'scripted',
      mode: 'choice',
      selected,
      ...options.confidence === undefined ? {} : { confidence: options.confidence },
      latencyMs: 1,
    }),
  })
}

/** A provider that returns candidates in a fixed order with descending scores. */
export function rankingProvider(order: string[], options: { id?: string; confidence?: number } = {}): ScriptedProvider {
  const id = options.id ?? 'scripted'
  return new ScriptedProvider({
    ...options.id === undefined ? {} : { id },
    plan: () => ({
      provider: id,
      mode: 'ranking',
      ...order[0] === undefined ? {} : { selected: order[0] },
      ranking: order.map((candidateId, index) => ({ id: candidateId, score: 1 - index / (order.length + 1) })),
      ...options.confidence === undefined ? {} : { confidence: options.confidence },
      latencyMs: 1,
    }),
  })
}

/** A provider that never settles; used for timeout tests. */
export function hangingProvider(id = 'hanging'): DecisionProvider {
  return {
    id,
    capabilities: ['choice'],
    decide: () => new Promise<DecisionResult>(() => undefined),
  }
}

/** A provider that throws a non-DecisionError. */
export function throwingProvider(message = 'boom', id = 'throwing'): DecisionProvider {
  return {
    id,
    capabilities: ['choice'],
    decide: () => {
      throw new Error(message)
    },
  }
}

/** A provider with a fixed health report. */
export function unhealthyProvider(health: ProviderHealth, id = 'unhealthy'): DecisionProvider {
  return {
    id,
    capabilities: ['choice'],
    decide: () => Promise.resolve({ provider: id, mode: 'choice' as const, latencyMs: 0 }),
    healthCheck: () => Promise.resolve(health),
  }
}

/** A tiny in-memory "page" the browser fake renders a snapshot for. */
export interface FakePageItem {
  index: number
  role: string
  name: string
  disabled?: boolean
  checked?: boolean
  href?: string
}

/** A fake browser: holds a page, renders the bridge's snapshot text, applies clicks. */
export class FakeBrowser {
  title: string
  url: string
  main: string
  items: FakePageItem[]
  readonly clicks: number[] = []
  readonly presses: string[] = []
  readonly typed: { index: number; text: string }[] = []
  snapshotCalls = 0
  /** When set, every snapshot fails with this message (simulates a locked capability). */
  failWith: string | undefined
  /** When true, the page renders no interactive inventory. */
  empty = false

  constructor(init: { title?: string; url?: string; main?: string; items?: FakePageItem[] }) {
    this.title = init.title ?? 'Fake page'
    this.url = init.url ?? 'https://example.test/'
    this.main = init.main ?? ''
    this.items = init.items ?? []
  }

  /** The dispatcher the browser adapter consumes. */
  dispatcher(): ReturnType<typeof createMapDispatcher> {
    return createMapDispatcher({
      browser_snapshot: (): ToolCallResult => {
        this.snapshotCalls += 1
        if (this.failWith !== undefined) return { ok: false, text: '', error: `browser_snapshot: ${this.failWith}` }
        return { ok: true, text: this.render() }
      },
      browser_click: (args): ToolCallResult => {
        const index = Number(args.index)
        this.clicks.push(index)
        const item = this.items.find(entry => entry.index === index)
        if (item !== undefined && item.role === 'button') {
          this.main = `clicked ${item.name}`
          this.items = this.items.filter(entry => entry.index !== index)
        }
        return { ok: true, text: `clicked ${String(index)}` }
      },
      browser_type: (args): ToolCallResult => {
        this.typed.push({ index: Number(args.index), text: String(args.text ?? '') })
        return { ok: true, text: `typed into ${String(args.index)}` }
      },
      browser_press: (args): ToolCallResult => {
        this.presses.push(String(args.key))
        return { ok: true, text: `pressed ${String(args.key)}` }
      },
      browser_scroll: (): ToolCallResult => ({ ok: true, text: 'scrolled' }),
      browser_navigate: (): ToolCallResult => ({ ok: true, text: 'navigated' }),
      browser_wait: (): ToolCallResult => ({ ok: true, text: 'waited' }),
    })
  }

  /** Render the same text shape the browser bridge renders. */
  render(): string {
    const lines: string[] = []
    lines.push(`Title: ${this.title}`)
    lines.push(`URL: ${this.url}`)
    lines.push('Status: complete')
    if (this.main !== '') {
      lines.push('')
      lines.push('Main content:')
      lines.push(this.main)
    }
    if (!this.empty && this.items.length > 0) {
      lines.push('')
      lines.push('Interactive elements:')
      for (const item of this.items) {
        const state = item.disabled === true ? ' [disabled]' : item.checked === undefined ? '' : ` [${item.checked ? 'checked' : 'unchecked'}]`
        const href = item.href === undefined ? '' : ` → ${item.href}`
        lines.push(`  [${item.index}] ${item.role} "${item.name}"${state}${href}`)
      }
    }
    return lines.join('\n')
  }
}

/** A simple counter environment: `increment` until `target`. */
export function counterEnvironment(options: { target: number; id?: string; noProgress?: boolean }): {
  adapter: CustomEnvironmentAdapter<{ count: number }>
  spec: CustomEnvironmentSpec<{ count: number }>
  readonly executed: string[]
} {
  const executed: string[] = []
  const spec: CustomEnvironmentSpec<{ count: number }> = {
    id: options.id ?? 'counter',
    observe: () => ({ count: 0 }),
    candidates: [
      { id: 'increment', description: 'Add one', action: { by: 1 } },
      { id: 'reset', description: 'Reset to zero', action: { by: 0 }, risky: true },
    ],
    execute: (candidate) => {
      executed.push(candidate.id)
      return { ok: true, message: `ran ${candidate.id}` }
    },
    isDone: () => false,
  }
  return {
    adapter: new CustomEnvironmentAdapter(spec),
    spec,
    get executed(): string[] {
      return executed
    },
  }
}

/**
 * A scripted environment that advances through a list of states, so the
 * runtime's loop guards can be exercised deterministically.
 */
export function scriptedEnvironment(options: {
  id?: string
  states: unknown[]
  candidates?: { id: string; description: string }[]
  risky?: string[]
  doneAt?: number
  failExecute?: string
}): { adapter: CustomEnvironmentAdapter<unknown>; readonly executed: string[]; readonly observations: number } {
  const executed: string[] = []
  const tracker = { observations: 0 }
  const candidates = options.candidates ?? [
    { id: 'advance', description: 'Advance the state' },
    { id: 'wait', description: 'Do nothing' },
    ...(options.risky ?? []).map(id => ({ id, description: `Perform ${id}` })),
  ]
  const adapter = new CustomEnvironmentAdapter<unknown>({
    id: options.id ?? 'scripted-env',
    observe: () => {
      const state = options.states[Math.min(tracker.observations, options.states.length - 1)]
      tracker.observations += 1
      return state
    },
    candidates: candidates.map(candidate => ({
      ...candidate,
      ...options.risky?.includes(candidate.id) === true ? { risky: true } : {},
    })),
    execute: (candidate) => {
      executed.push(candidate.id)
      if (options.failExecute === candidate.id) return { ok: false, message: 'execution refused' }
      return { ok: true, message: `ran ${candidate.id}` }
    },
    ...options.doneAt === undefined ? {} : {
      isDone: () => tracker.observations >= (options.doneAt ?? Number.POSITIVE_INFINITY),
    },
  })
  return {
    adapter,
    executed,
    get observations(): number {
      return tracker.observations
    },
  }
}

/** An observation helper for direct adapter tests. */
export function observationOf(state: unknown): ReturnType<typeof okObservation> {
  return okObservation('custom', state)
}
