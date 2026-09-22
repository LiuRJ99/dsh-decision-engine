/**
 * Browser Environment Adapter.
 *
 * Responsibilities, in order: observe the page through the browser tool set,
 * build a finite decision request from that structured state, map the chosen
 * candidate id to a concrete browser action, and execute it.
 *
 * Two boundaries this adapter keeps:
 *
 * - It is text-only. It reads the bridge's structured snapshot; it never asks
 *   for a screenshot and never interprets pixels.
 * - It never maps a decision to a raw tool call itself. That is: the provider
 *   returns `submit`, and *this* adapter decides that `submit` means
 *   `browser_click(index=17)`. The provider has no idea a tool named
 *   `browser_click` exists.
 *
 * Authorization is deliberately absent from this file. Observation and
 * execution both go through {@link ToolDispatcher}, which dispatches the
 * host's registered tools, so the session's capability gate decides whether
 * the browser capability is reachable — and a refusal comes back as an
 * observation status or an escalation, never as a workaround.
 *
 * @module dsh-decision-engine/environments/browser/adapter
 */

import { DecisionError } from '../../core/errors.ts'
import type { DecisionRankEntry, DecisionRequest, DecisionResult } from '../../core/types.ts'
import type { EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, ObserveInput, Observation } from '../types.ts'
import { failedObservation, okObservation } from '../types.ts'
import { requireDispatcher, type ToolDispatcher } from '../dispatch.ts'
import { looksCanvasLike, parseBrowserSnapshot, type BrowserSnapshot } from './snapshot.ts'

/** Tool names this adapter dispatches. They are the bridge's public tool surface. */
export const BROWSER_TOOLS = {
  snapshot: 'browser_snapshot',
  getText: 'browser_get_text',
  click: 'browser_click',
  type: 'browser_type',
  press: 'browser_press',
  scroll: 'browser_scroll',
  navigate: 'browser_navigate',
  wait: 'browser_wait',
} as const

/**
 * How the adapter turns a page into candidates.
 *
 * `form` — the page's own buttons, links, and fields answer the objective.
 * `patch` — the caller supplies the candidate set (a workflow's own steps).
 */
export type BrowserCandidateStrategy = 'form' | 'patch'

/** Adapter configuration. */
export interface BrowserAdapterConfig {
  /** Candidate derivation strategy. Defaults to `form`. */
  strategy?: BrowserCandidateStrategy
  /**
   * Candidates supplied by the caller when `strategy` is `patch`. Each entry
   * carries a `target` describing the browser action it performs.
   */
  candidates?: BrowserActionCandidate[]
  /** Hard cap on derived candidates. Defaults to 12. */
  maxCandidates?: number
  /** Hard cap on characters of page text placed into the decision state. Defaults to 6000. */
  maxStateChars?: number
  /** Hard cap on characters of the objective. Defaults to 2000. */
  maxObjectiveChars?: number
  /** Per-call budgets forwarded to the tool dispatch. */
  observeTimeoutMs?: number
  executeTimeoutMs?: number
}

/**
 * A candidate plus the browser action it performs.
 *
 * This is the adapter's own vocabulary: a candidate id is what the decision
 * provider sees; `action` is what the adapter does with it. Keeping the two in
 * one record is what makes the mapping total — every offered candidate is
 * executable, so a provider can never choose something unmappable.
 */
export interface BrowserActionCandidate {
  id: string
  description: string
  action: {
    kind: 'click' | 'type' | 'press' | 'scroll' | 'navigate' | 'wait'
    /** Snapshot index for click/type, or the key for press, or the direction for scroll, or the url for navigate. */
    target?: number | string
    /** Text for `type`, milliseconds for `wait`. */
    text?: string
    /** Whether `type` replaces rather than appends. */
    replace?: boolean
    /** Whether the action is externally visible or hard to undo. */
    risky?: boolean
  }
  metadata?: Record<string, unknown>
}

const DEFAULT_MAX_CANDIDATES = 12
const DEFAULT_MAX_STATE_CHARS = 6_000
const DEFAULT_MAX_OBJECTIVE_CHARS = 2_000

/** Roles whose activation is a plain click, in the order they are preferred. */
const PRIMARY_ROLES = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'] as const

/**
 * The browser adapter. One instance drives one controlled tab.
 */
export class BrowserEnvironmentAdapter implements EnvironmentAdapter {
  readonly id: string
  readonly source = 'browser' as const
  readonly capabilities = ['observe', 'buildDecisionRequest', 'mapDecision', 'execute'] as const

  readonly #dispatcher: ToolDispatcher
  readonly #config: Required<Omit<BrowserAdapterConfig, 'candidates'>> & { candidates: BrowserActionCandidate[] | undefined }
  /** Candidate index for the observation the last request was built from. */
  #pendingCandidates = new Map<string, BrowserActionCandidate>()

  constructor(options: { id?: string; dispatcher: ToolDispatcher; config?: BrowserAdapterConfig }) {
    this.id = options.id ?? 'browser'
    this.#dispatcher = options.dispatcher
    const config = options.config ?? {}
    this.#config = {
      strategy: config.strategy ?? 'form',
      candidates: config.candidates,
      maxCandidates: config.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      maxStateChars: config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS,
      maxObjectiveChars: config.maxObjectiveChars ?? DEFAULT_MAX_OBJECTIVE_CHARS,
      observeTimeoutMs: config.observeTimeoutMs ?? 90_000,
      executeTimeoutMs: config.executeTimeoutMs ?? 90_000,
    }
  }

  /**
   * Read the page as structured text.
   *
   * A refused or failed snapshot becomes `unsupported`/`error`, never a guess:
   * the caller escalates instead of the adapter inventing state.
   */
  async observe(input?: ObserveInput): Promise<Observation> {
    void input
    const result = await this.#dispatcher.call({
      name: BROWSER_TOOLS.snapshot,
      arguments: {},
      ...input?.signal === undefined ? {} : { signal: input.signal },
    })
    if (!result.ok) {
      const message = result.error ?? 'browser_snapshot failed.'
      return failedObservation('browser', 'unsupported', message, {
        metadata: { tool: BROWSER_TOOLS.snapshot, hint: 'Authorize the browser capability for this session (/browser) and retry.' },
      })
    }
    const snapshot = parseBrowserSnapshot(result.text)
    return this.#observationFrom(snapshot, result.text.length)
  }

  /**
   * Build the decision request from a browser snapshot.
   *
   * The state handed to the provider is a *structured digest* — url, title, the
   * interactive inventory, the form inventory, and a bounded slice of page
   * text — so a provider reads structure rather than re-parsing prose. Page
   * text is treated as untrusted data and is explicitly labelled as such.
   */
  buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest {
    if (observation.status !== 'ok') {
      throw new DecisionError('insufficient_observation', `Cannot build a decision request from a ${observation.status} observation.`, {
        subject: this.id,
        details: { reason: observation.reason },
      })
    }
    const snapshot = observation.state as BrowserSnapshot
    const candidates = this.#candidatesFor(snapshot)
    if (candidates.length === 0) {
      throw new DecisionError('no_candidates', 'The page offers no addressable action for this objective.', {
        subject: this.id,
        details: { url: snapshot.url, strategy: this.#config.strategy },
      })
    }
    this.#pendingCandidates = new Map(candidates.map(candidate => [candidate.id, candidate]))

    const state: Record<string, unknown> = {
      url: snapshot.url ?? '',
      title: snapshot.title ?? '',
      status: snapshot.status ?? '',
      pageTextUntrusted: truncate(snapshot.main, this.#config.maxStateChars),
      interactive: snapshot.items.map(item => ({
        index: item.index,
        role: item.role,
        name: item.name,
        ...item.disabled ? { disabled: true } : {},
        ...item.checked === undefined ? {} : { checked: item.checked },
        ...item.href === undefined ? {} : { href: item.href },
      })),
      formFields: snapshot.forms.map(field => ({
        index: field.index,
        ...field.label === undefined ? {} : { label: field.label },
        ...field.kind === undefined ? {} : { kind: field.kind },
        ...field.value === undefined ? {} : { value: field.masked ? '(masked)' : field.value },
        ...field.checked === undefined ? {} : { checked: field.checked },
        ...field.required ? { required: true } : {},
      })),
    }

    return {
      objective: truncate(objective.description, this.#config.maxObjectiveChars),
      state,
      candidates: candidates.map(candidate => ({
        id: candidate.id,
        description: candidate.description,
        ...candidate.metadata === undefined ? {} : { metadata: candidate.metadata },
      })),
      ...objective.constraints === undefined ? {} : { constraints: objective.constraints },
      mode: 'choice',
      metadata: { environment: this.id, url: snapshot.url ?? '' },
    }
  }

  /**
   * Map a chosen candidate id to a browser action.
   *
   * @throws DecisionError with `unknown_candidate` when the id is not one this
   *   adapter offered for the observation the request was built from.
   */
  mapDecision(result: DecisionResult, observation: Observation): EnvironmentAction {
    const selected = result.selected
    if (selected === undefined) {
      throw new DecisionError('invalid_decision', `Provider "${result.provider}" returned no selection.`, { subject: result.provider })
    }
    const candidate = this.#pendingCandidates.get(selected) ?? this.#recoverCandidate(observation, selected)
    if (candidate === undefined) {
      throw new DecisionError('unknown_candidate', `Decision "${selected}" does not map to a browser action.`, {
        subject: this.id,
        details: { selected, offered: [...this.#pendingCandidates.keys()] },
      })
    }
    return this.#actionFrom(candidate)
  }

  /** Execute a mapped action through the browser tool set. */
  async execute(action: EnvironmentAction, input?: ExecuteInput): Promise<{ ok: boolean; message: string }> {
    const payload = action.payload ?? {}
    const signal = input?.signal
    const target = action.target
    switch (action.kind) {
      case 'click': {
        if (typeof target !== 'number') {
          throw new DecisionError('action_mapping_failed', `click requires a numeric snapshot index; got ${String(target)}.`, { subject: this.id })
        }
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.click,
          arguments: { index: target },
          ...signal === undefined ? {} : { signal },
        })
        return outcome(result, 'click failed')
      }
      case 'type': {
        if (typeof target !== 'number') {
          throw new DecisionError('action_mapping_failed', `type requires a numeric field index; got ${String(target)}.`, { subject: this.id })
        }
        const text = typeof payload.text === 'string' ? payload.text : ''
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.type,
          arguments: { index: target, text, ...payload.replace === true ? { replace: true } : {} },
          ...signal === undefined ? {} : { signal },
        })
        return outcome(result, 'type failed')
      }
      case 'press': {
        const key = typeof target === 'string' ? target : 'Enter'
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.press,
          arguments: { key },
          ...signal === undefined ? {} : { signal },
        })
        return outcome(result, 'press failed')
      }
      case 'scroll': {
        const direction = typeof target === 'string' ? target : 'down'
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.scroll,
          arguments: { direction, ...typeof payload.amount === 'number' ? { amount: payload.amount } : {} },
          ...signal === undefined ? {} : { signal },
        })
        return outcome(result, 'scroll failed')
      }
      case 'navigate': {
        if (typeof target !== 'string') {
          throw new DecisionError('action_mapping_failed', `navigate requires a url string; got ${String(target)}.`, { subject: this.id })
        }
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.navigate,
          arguments: { url: target },
          ...signal === undefined ? {} : { signal },
        })
        return outcome(result, 'navigate failed')
      }
      case 'wait': {
        const ms = typeof payload.ms === 'number' ? payload.ms : 500
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.wait,
          arguments: { ms },
          ...signal === undefined ? {} : { signal },
        })
        return outcome(result, 'wait failed')
      }
      default:
        throw new DecisionError('action_mapping_failed', `Unsupported browser action kind "${action.kind}".`, { subject: this.id })
    }
  }

  /** The tool names this adapter needs visible in the session. */
  requiredTools(): string[] {
    return Object.values(BROWSER_TOOLS)
  }

  /** Assert the dispatcher is present, with a typed error. */
  assertWired(): void {
    requireDispatcher(this.#dispatcher, this.id)
  }

  #observationFrom(snapshot: BrowserSnapshot, textChars: number): Observation {
    const addressable = snapshot.items.length + snapshot.forms.length
    if (addressable === 0 && snapshot.mainChars === 0) {
      return failedObservation('browser', 'insufficient', 'The snapshot contained no readable text and no interactive elements.', {
        metadata: { url: snapshot.url, textChars, unparsed: snapshot.unparsed.slice(0, 5) },
      })
    }
    if (looksCanvasLike(snapshot)) {
      return failedObservation('browser', 'unsupported', 'The page exposes no structured state (canvas/WebGL/video only, or an effectively empty DOM).', {
        metadata: { url: snapshot.url, textChars, addressable },
      })
    }
    // Read-only result pages are valid observations. Completion is checked
    // before candidate derivation; an unfinished page still fails no_candidates.
    if (snapshot.unparsed.length > snapshot.items.length + snapshot.forms.length) {
      return failedObservation('browser', 'insufficient', 'Most snapshot lines could not be parsed, so the page structure is not trustworthy.', {
        metadata: { url: snapshot.url, unparsed: snapshot.unparsed.slice(0, 5) },
      })
    }
    return okObservation('browser', snapshot, {
      summary: summarize(snapshot),
      metadata: {
        ...snapshot.url === undefined ? {} : { url: snapshot.url },
        itemCount: snapshot.items.length,
        formCount: snapshot.forms.length,
        reindexed: snapshot.reindexed,
        ...snapshot.mainChars > this.#config.maxStateChars ? { pageTextTruncated: true } : {},
      },
    })
  }

  /**
   * Derive the finite candidate set. In `form` strategy the page's own
   * controls become candidates; each candidate carries the exact action it
   * performs, so mapping is total by construction.
   */
  #candidatesFor(snapshot: BrowserSnapshot): BrowserActionCandidate[] {
    if (this.#config.strategy === 'patch') {
      const patched = this.#config.candidates ?? []
      return patched.slice(0, this.#config.maxCandidates)
    }
    const candidates: BrowserActionCandidate[] = []
    const seen = new Set<string>()
    const push = (candidate: BrowserActionCandidate): void => {
      if (candidates.length >= this.#config.maxCandidates) return
      if (seen.has(candidate.id)) return
      seen.add(candidate.id)
      candidates.push(candidate)
    }

    const items = [...snapshot.items].sort((left, right) => {
      const leftPrimary = (PRIMARY_ROLES as readonly string[]).includes(left.role) ? 0 : 1
      const rightPrimary = (PRIMARY_ROLES as readonly string[]).includes(right.role) ? 0 : 1
      if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary
      if (left.disabled !== right.disabled) return left.disabled ? 1 : -1
      return left.index - right.index
    })

    for (const item of items) {
      if (item.disabled) continue
      const role = item.role.toLowerCase()
      if (!(PRIMARY_ROLES as readonly string[]).includes(role)) continue
      const label = item.name === '' ? `element ${item.index}` : item.name
      if (role === 'checkbox' || role === 'radio') {
        push({
          id: `set-${slug(label)}-${item.index}`,
          description: `${item.checked === true ? 'Uncheck' : 'Check'} "${label}"`,
          action: { kind: 'click', target: item.index },
          metadata: { role, index: item.index },
        })
        continue
      }
      push({
        id: `click-${slug(label)}-${item.index}`,
        description: `${role === 'link' ? 'Follow' : 'Activate'} "${label}"${item.href === undefined ? '' : ` (${item.href})`}`,
        action: { kind: 'click', target: item.index },
        metadata: { role, index: item.index, ...item.href === undefined ? {} : { href: item.href } },
      })
    }

    for (const field of snapshot.forms) {
      const label = field.label ?? `field ${field.index}`
      if (field.checked !== undefined) continue
      if (field.value !== undefined && field.value !== '' && field.masked !== true) {
        push({
          id: `clear-${slug(label)}-${field.index}`,
          description: `Clear the "${label}" field`,
          action: { kind: 'type', target: field.index, text: '', replace: true },
          metadata: { role: 'field', index: field.index },
        })
        continue
      }
      push({
        id: `focus-${slug(label)}-${field.index}`,
        description: `Focus the "${label}" field`,
        action: { kind: 'click', target: field.index },
        metadata: { role: 'field', index: field.index },
      })
    }

    if (snapshot.items.length > 0 || snapshot.forms.length > 0) {
      push({ id: 'wait', description: 'Wait for the page to change', action: { kind: 'wait', target: 'wait' } })
    }
    return candidates
  }

  /** Recover an action candidate from a fresh parse, for a request built by another instance/call. */
  #recoverCandidate(observation: Observation, selected: string): BrowserActionCandidate | undefined {
    if (observation.status !== 'ok') return undefined
    const snapshot = observation.state as BrowserSnapshot
    return this.#candidatesFor(snapshot).find(candidate => candidate.id === selected)
  }

  #actionFrom(candidate: BrowserActionCandidate): EnvironmentAction {
    const action: EnvironmentAction = {
      kind: candidate.action.kind,
      candidateId: candidate.id,
      description: candidate.description,
    }
    if (candidate.action.target !== undefined) action.target = candidate.action.target
    const payload: Record<string, unknown> = {}
    if (candidate.action.text !== undefined) payload.text = candidate.action.text
    if (candidate.action.replace !== undefined) payload.replace = candidate.action.replace
    if (Object.keys(payload).length > 0) action.payload = payload
    if (candidate.action.risky === true) action.risky = true
    return action
  }
}

/** Rank entries helper used by adapters that need to keep the provider's order. */
export function selectionOrder(ranking: DecisionRankEntry[] | undefined, selected: string): string[] {
  const ids = (ranking ?? []).map(entry => entry.id)
  return ids.includes(selected) ? ids : [selected, ...ids]
}

function summarize(snapshot: BrowserSnapshot): string {
  const parts: string[] = []
  if (snapshot.title !== undefined && snapshot.title !== '') parts.push(snapshot.title)
  if (snapshot.url !== undefined && snapshot.url !== '') parts.push(snapshot.url)
  parts.push(`${snapshot.items.length} interactive element(s)`)
  if (snapshot.forms.length > 0) parts.push(`${snapshot.forms.length} form field(s)`)
  if (snapshot.reindexed) parts.push('indices reassigned')
  return parts.join(' · ')
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'item' : cleaned.slice(0, 32)
}

function firstLine(value: string): string | undefined {
  const line = value.split('\n').map(part => part.trim()).find(part => part !== '')
  return line === undefined ? undefined : line.slice(0, 200)
}

/** Normalize a dispatch result into an execution result with a message. */
function outcome(result: { ok: boolean; text: string; error?: string | undefined }, fallback: string): { ok: boolean; message: string } {
  if (result.ok) return { ok: true, message: firstLine(result.text) ?? 'ok' }
  return { ok: false, message: result.error ?? fallback }
}
