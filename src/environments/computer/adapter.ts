/**
 * Computer Environment Adapter.
 *
 * The desktop is observed through its accessibility tree and acted on through
 * element indexes. Screenshots are never read: the computer-use engine returns
 * one alongside the tree, and this adapter ignores it — that is a deliberate
 * boundary, not an oversight.
 *
 * Two access paths are supported, and the choice between them is a deployment
 * decision rather than an architectural one:
 *
 * - `engine` — the in-process `ctx.computer` seam, when the computer-use plugin
 *   is mounted. Cheap, typed, and no tool round-trip.
 * - `tools` — the registered `computer_use_*` tools, when the adapter runs
 *   somewhere the seam is not reachable.
 *
 * Both paths are gated by the same session authorization as a model call, so
 * the adapter cannot reach a desktop the user has not unlocked.
 *
 * @module dsh-decision-engine/environments/computer/adapter
 */

import { DecisionError } from '../../core/errors.ts'
import type { DecisionRequest, DecisionResult } from '../../core/types.ts'
import type { EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, ObserveInput, Observation } from '../types.ts'
import { failedObservation, okObservation } from '../types.ts'
import { requireDispatcher, type ToolDispatcher } from '../dispatch.ts'
import { isAddressable, isPassive, isSettable, labelOf, mergeAxDiff, parseAxTree, type AxCapture, type AxNode } from './ax-tree.ts'

/** Tool names of the computer-use family that this adapter dispatches. */
export const COMPUTER_TOOLS = {
  listApps: 'computer_use_list_apps',
  getAppState: 'computer_use_get_app_state',
  click: 'computer_use_click',
  typeText: 'computer_use_type_text',
  pressKey: 'computer_use_press_key',
  scroll: 'computer_use_scroll',
  setValue: 'computer_use_set_value',
  selectText: 'computer_use_select_text',
} as const

/**
 * The in-process computer seam this adapter prefers when it is mounted.
 *
 * Structurally typed on purpose: the decision layer declares the shape it
 * consumes instead of importing the computer-use package, so the two can be
 * versioned independently and neither becomes the other's compile-time
 * dependency. The shapes mirror the documented `ctx.computer` contract.
 */
export interface ComputerSeam {
  /**
   * Apply the implementation's own defaults and caps to a request.
   *
   * The documented `ctx.computer` contract requires it: every operation method
   * receives an already-resolved spec and never re-defaults its fields. It is
   * declared optional because a hand-built seam may not need it, and the
   * adapter passes the raw request when it is absent.
   */
  resolve?<T extends Record<string, unknown>>(request: T): unknown
  listApps(request?: unknown): Promise<unknown>
  getAppState(request: unknown): Promise<ComputerSeamState>
  click(request: unknown): Promise<unknown>
  typeText(request: unknown): Promise<unknown>
  pressKey(request: unknown): Promise<unknown>
  scroll(request: unknown): Promise<unknown>
  setValue(request: unknown): Promise<unknown>
  selectText?(request: unknown): Promise<unknown>
}

/** The subset of a computer seam capture this adapter reads. */
export interface ComputerSeamState {
  app: string
  text: string
  truncated?: boolean
  /** Present on the real seam; deliberately never read by this adapter. */
  screenshot?: unknown
}

/** One candidate plus the desktop action it performs. */
export interface ComputerActionCandidate {
  id: string
  description: string
  action: {
    kind: 'click' | 'set_value' | 'press_key' | 'scroll' | 'type_text' | 'select_text'
    /** AX element index for element-addressed actions. */
    elementIndex?: number
    /** Value for `set_value`. */
    value?: string
    /** Key or chord for `press_key`. */
    key?: string
    /** Direction for `scroll`. */
    direction?: 'up' | 'down' | 'left' | 'right'
    /** Literal text for `type_text`. */
    text?: string
    /** Text to locate for `select_text`. */
    find?: string
  }
  metadata?: Record<string, unknown>
}

/** Adapter configuration. */
export interface ComputerAdapterConfig {
  /** App identifier (bundle id, display name, or path). Required to observe. */
  app?: string
  /** When true, the observation carries the app list so a later step can choose a target. */
  listAppsInObservation?: boolean
  /**
   * Fixed candidate set. Omit to derive candidates from the accessibility tree.
   * A fixed set is the "patch" strategy: the workflow decides what may happen.
   */
  candidates?: ComputerActionCandidate[]
  /** Hard cap on derived candidates. Defaults to 12. */
  maxCandidates?: number
  /** Hard cap on characters of AX text placed into the decision state. Defaults to 8000. */
  maxStateChars?: number
  /** `max` returns the full tree from the seam; a number caps it. Defaults to 1200 nodes. */
  maxTreeNodes?: number
  /**
   * How long to wait for one accessibility capture before giving up. A capture
   * can block on a permission prompt or a wedged daemon, and a decision loop
   * must not wait forever for one observation. Defaults to 30 s.
   */
  captureTimeoutMs?: number
}

const DEFAULT_MAX_CANDIDATES = 12
const DEFAULT_MAX_STATE_CHARS = 8_000

/**
 * Race a promise against a deadline.
 *
 * A provider-owned cancel signal is still forwarded; this only guarantees that
 * the *caller* settles, which is what keeps a bounded loop bounded even when
 * the transport cannot be interrupted.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The computer adapter.
 */
export class ComputerEnvironmentAdapter implements EnvironmentAdapter {
  readonly id: string
  readonly source = 'computer' as const
  readonly capabilities = ['observe', 'buildDecisionRequest', 'mapDecision', 'execute'] as const

  readonly #seam: ComputerSeam | undefined
  readonly #dispatcher: ToolDispatcher | undefined
  readonly #config: Required<Omit<ComputerAdapterConfig, 'app' | 'candidates'>> & { app: string | undefined; candidates: ComputerActionCandidate[] | undefined }
  #pendingCandidates = new Map<string, ComputerActionCandidate>()
  #pendingApp: string | undefined
  /**
   * The last full capture per app, so a diff the provider returns can be
   * overlaid onto it. The documented `ctx.computer` contract returns a diff for
   * every capture after the first, and a diff alone cannot yield a candidate
   * set — but previous-plus-diff can, exactly as the provider intends.
   */
  readonly #lastFullCapture = new Map<string, AxCapture>()

  constructor(options: { id?: string; seam?: ComputerSeam; dispatcher?: ToolDispatcher; config?: ComputerAdapterConfig }) {
    this.id = options.id ?? 'computer'
    this.#seam = options.seam
    this.#dispatcher = options.dispatcher
    const config = options.config ?? {}
    this.#config = {
      app: config.app,
      candidates: config.candidates,
      listAppsInObservation: config.listAppsInObservation ?? false,
      maxCandidates: config.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      maxStateChars: config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS,
      maxTreeNodes: config.maxTreeNodes ?? 1_200,
      captureTimeoutMs: config.captureTimeoutMs ?? 30_000,
    }
  }

  /** Whether the in-process seam is available. */
  get hasSeam(): boolean {
    return this.#seam !== undefined
  }

  /** The app this adapter targets, once configured. */
  get app(): string | undefined {
    return this.#config.app
  }

  /**
   * Capture the target app's accessibility tree.
   *
   * A missing app target, a refused capture, or an unreadable tree becomes a
   * non-`ok` observation: an AX tree that only contains anonymous groups
   * cannot express a task, and this adapter says so instead of guessing.
   */
  async observe(input?: ObserveInput): Promise<Observation> {
    const app = this.#config.app
    if (app === undefined || app === '') {
      return failedObservation('computer', 'insufficient', 'No target app is configured for the computer environment.', {
        metadata: { hint: 'Pass app in the environment config, or list apps and choose one first.' },
      })
    }
    const capture = await this.#capture(app, input?.signal)
    if (!capture.ok) {
      return failedObservation('computer', 'unsupported', capture.error, {
        metadata: { app, hint: 'Authorize the computer capability for this session (/computer-use) and retry.' },
      })
    }
    this.#pendingApp = capture.app
    const parsed = parseAxTree(capture.text, capture.truncated)
    const ax = this.#resolveCapture(capture.app, parsed)
    if (ax === undefined) {
      // A diff with no preceding full capture: the tree cannot be reconstructed,
      // so this is reported rather than guessed at.
      return failedObservation('computer', 'insufficient',
        'The provider returned a diff and no full capture of this app is available to reconstruct the tree from.', {
          metadata: {
            app: capture.app,
            hint: 'Capture once with disableDiff, or capture the same app twice so the second capture can be merged.',
          },
        })
    }
    return this.#observationFrom(capture.app, ax, capture.text)
  }

  /** Apps the desktop exposes, for choosing a target. */
  async listApps(): Promise<{ ok: boolean; text: string }> {
    if (this.#seam !== undefined) {
      try {
        const value = await this.#seam.listApps({})
        return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value) }
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) }
      }
    }
    const dispatcher = requireDispatcher(this.#dispatcher, this.id)
    const result = await dispatcher.call({ name: COMPUTER_TOOLS.listApps, arguments: {} })
    return { ok: result.ok, text: result.ok ? result.text : result.error ?? '' }
  }

  /**
   * Build the decision request from an AX capture.
   *
   * The state is a structured digest: the app id, the capture kind (full vs
   * diff), and the nodes with their roles, names, and depths. The rendered
   * tree text is included only as a bounded, explicitly-untrusted transcript.
   */
  buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest {
    if (observation.status !== 'ok') {
      throw new DecisionError('insufficient_observation', `Cannot build a decision request from a ${observation.status} observation.`, {
        subject: this.id,
        details: { reason: observation.reason },
      })
    }
    const state = observation.state as { app: string; ax: AxCapture; text: string }
    const candidates = this.#candidatesFor(state.ax)
    if (candidates.length === 0) {
      throw new DecisionError('no_candidates', 'The accessibility tree offers no addressable action for this objective.', {
        subject: this.id,
        details: { app: state.app, nodeCount: state.ax.nodes.length },
      })
    }
    this.#pendingCandidates = new Map(candidates.map(candidate => [candidate.id, candidate]))

    return {
      objective: objective.description,
      state: {
        app: state.app,
        captureKind: state.ax.kind,
        window: state.ax.window ?? null,
        nodes: state.ax.nodes.filter(node => !node.removed).map(node => ({
          index: node.index,
          role: node.role,
          label: labelOf(node),
          depth: node.depth,
          ...node.value === undefined ? {} : { value: node.value },
          ...node.disabled ? { disabled: true } : {},
          ...node.settable ? { settable: true } : {},
          ...node.secondaryActions.length === 0 ? {} : { secondaryActions: node.secondaryActions },
        })),
        truncated: state.ax.truncated,
        treeTextUntrusted: truncate(state.text, this.#config.maxStateChars),
      },
      candidates: candidates.map(candidate => ({
        id: candidate.id,
        description: candidate.description,
        ...candidate.metadata === undefined ? {} : { metadata: candidate.metadata },
      })),
      ...objective.constraints === undefined ? {} : { constraints: objective.constraints },
      mode: 'choice',
      metadata: { environment: this.id, app: state.app },
    }
  }

  /** Map a chosen candidate id to a desktop action. */
  mapDecision(result: DecisionResult, observation: Observation): EnvironmentAction {
    const selected = result.selected
    if (selected === undefined) {
      throw new DecisionError('invalid_decision', `Provider "${result.provider}" returned no selection.`, { subject: result.provider })
    }
    const candidate = this.#pendingCandidates.get(selected)
      ?? (observation.status === 'ok'
        ? this.#candidatesFor((observation.state as { ax: AxCapture }).ax).find(entry => entry.id === selected)
        : undefined)
    if (candidate === undefined) {
      throw new DecisionError('unknown_candidate', `Decision "${selected}" does not map to a desktop action.`, {
        subject: this.id,
        details: { selected, offered: [...this.#pendingCandidates.keys()] },
      })
    }
    const action: EnvironmentAction = {
      kind: candidate.action.kind,
      candidateId: candidate.id,
      description: candidate.description,
    }
    if (candidate.action.elementIndex !== undefined) action.target = candidate.action.elementIndex
    const payload: Record<string, unknown> = {}
    for (const key of ['value', 'key', 'direction', 'text', 'find'] as const) {
      const value = candidate.action[key]
      if (value !== undefined) payload[key] = value
    }
    if (Object.keys(payload).length > 0) action.payload = payload
    return action
  }

  /** Execute a mapped desktop action. */
  async execute(action: EnvironmentAction, _input?: ExecuteInput): Promise<{ ok: boolean; message?: string }> {
    const app = this.#pendingApp ?? this.#config.app
    if (app === undefined) {
      throw new DecisionError('action_mapping_failed', 'No target app is known; observe before executing an action.', { subject: this.id })
    }
    const elementIndex = typeof action.target === 'number' ? action.target : undefined
    const payload = action.payload ?? {}
    switch (action.kind) {
      case 'click':
        return this.#invoke('click', { app, ...elementIndex === undefined ? {} : { elementIndex } })
      case 'set_value': {
        if (elementIndex === undefined) {
          throw new DecisionError('action_mapping_failed', 'set_value requires an element index.', { subject: this.id })
        }
        return this.#invoke('setValue', { app, elementIndex, value: String(payload.value ?? '') })
      }
      case 'press_key':
        return this.#invoke('pressKey', { app, key: String(payload.key ?? 'Return') })
      case 'scroll': {
        if (elementIndex === undefined) {
          throw new DecisionError('action_mapping_failed', 'scroll requires an element index.', { subject: this.id })
        }
        return this.#invoke('scroll', { app, elementIndex, direction: String(payload.direction ?? 'down') })
      }
      case 'type_text':
        return this.#invoke('typeText', { app, text: String(payload.text ?? '') })
      case 'select_text': {
        if (elementIndex === undefined) {
          throw new DecisionError('action_mapping_failed', 'select_text requires an element index.', { subject: this.id })
        }
        return this.#invoke('selectText', { app, elementIndex, text: String(payload.find ?? '') })
      }
      default:
        throw new DecisionError('action_mapping_failed', `Unsupported computer action kind "${action.kind}".`, { subject: this.id })
    }
  }

  /** The tool names this adapter needs visible when it uses the tool path. */
  requiredTools(): string[] {
    return Object.values(COMPUTER_TOOLS)
  }

  async #capture(app: string, signal?: AbortSignal): Promise<{ ok: true; app: string; text: string; truncated: boolean } | { ok: false; error: string }> {
    if (this.#seam !== undefined) {
      try {
        const request = {
          app,
          maxTreeNodes: this.#config.maxTreeNodes,
          ...signal === undefined ? {} : { signal },
        }
        // `resolve` first, when the seam provides it: the documented contract
        // says operation methods receive a resolved spec, and a seam that
        // follows the contract expects one.
        const spec = typeof this.#seam.resolve === 'function' ? await this.#seam.resolve(request) : request
        const state = await withDeadline(
          this.#seam.getAppState(spec),
          this.#config.captureTimeoutMs,
          `the accessibility capture of "${app}" did not answer within ${this.#config.captureTimeoutMs}ms`,
        )
        // A seam that answers with nothing is a seam that failed; saying so is
        // better than reading properties off undefined.
        if (state === undefined || state === null) {
          return { ok: false, error: `the accessibility capture of "${app}" returned no state` }
        }
        return {
          ok: true,
          app: typeof state.app === 'string' && state.app !== '' ? state.app : app,
          text: typeof state.text === 'string' ? state.text : '',
          truncated: state.truncated === true,
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (this.#dispatcher === undefined) {
      return { ok: false, error: `Environment "${this.id}" has neither the ctx.computer seam nor a tool dispatcher.` }
    }
    const result = await this.#dispatcher.call({
      name: COMPUTER_TOOLS.getAppState,
      arguments: { app, maxTreeNodes: this.#config.maxTreeNodes },
      ...signal === undefined ? {} : { signal },
    })
    if (!result.ok) return { ok: false, error: result.error ?? 'computer_use_get_app_state failed.' }
    return { ok: true, app, text: result.text, truncated: /truncated/i.test(result.text) }
  }

  async #invoke(
    operation: 'click' | 'setValue' | 'pressKey' | 'scroll' | 'typeText' | 'selectText',
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; message?: string }> {
    if (this.#seam !== undefined) {
      const method = this.#seam[operation]
      if (typeof method !== 'function') {
        throw new DecisionError('environment_unavailable', `The mounted computer seam does not implement ${operation}().`, { subject: this.id })
      }
      try {
        const spec = typeof this.#seam.resolve === 'function' ? await this.#seam.resolve(args) : args
        const value = await method.call(this.#seam, spec)
        return { ok: true, ...typeof value === 'string' && value !== '' ? { message: value.slice(0, 200) } : {} }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
    const dispatcher = requireDispatcher(this.#dispatcher, this.id)
    const toolName = operation === 'setValue'
      ? COMPUTER_TOOLS.setValue
      : operation === 'pressKey'
        ? COMPUTER_TOOLS.pressKey
        : operation === 'typeText'
          ? COMPUTER_TOOLS.typeText
          : operation === 'selectText'
            ? COMPUTER_TOOLS.selectText
            : operation === 'scroll'
              ? COMPUTER_TOOLS.scroll
              : COMPUTER_TOOLS.click
    const result = await dispatcher.call({ name: toolName, arguments: args })
    return result.ok
      ? { ok: true, ...firstLine(result.text) === undefined ? {} : { message: firstLine(result.text) as string } }
      : { ok: false, message: result.error ?? `${toolName} failed` }
  }

  /**
   * Turn a parsed capture into a usable full tree.
   *
   * A full capture is stored as the merge base. A diff is overlaid onto it; a
   * diff that announces no change reuses the stored tree as-is.
   */
  #resolveCapture(app: string, parsed: AxCapture): AxCapture | undefined {
    if (parsed.kind === 'full') {
      this.#lastFullCapture.set(app, parsed)
      return parsed
    }
    const base = this.#lastFullCapture.get(app)
    if (base === undefined) return undefined
    const merged = mergeAxDiff(base, parsed)
    if (merged === undefined) return base
    const next: AxCapture = { ...base, kind: 'full', nodes: merged, unparsed: [] }
    const appId = parsed.app ?? base.app
    if (appId !== undefined) next.app = appId
    const window = parsed.window ?? base.window
    if (window !== undefined) next.window = window
    this.#lastFullCapture.set(app, next)
    return next
  }

  #observationFrom(app: string, ax: AxCapture, text: string): Observation {
    const live = ax.nodes.filter(node => !node.removed)
    if (live.length === 0) {
      return failedObservation('computer', 'insufficient', 'The accessibility capture contained no elements.', {
        metadata: { app, textChars: text.length, unparsed: ax.unparsed.slice(0, 5) },
      })
    }
    const addressable = live.filter(node => isAddressable(node))
    const named = live.filter(node => labelOf(node) !== `${node.role} ${node.index}`)
    const groups = live.filter(node => node.role === 'group').length
    if (addressable.length === 0) {
      if (groups >= live.length && live.length > 1) {
        return failedObservation('computer', 'insufficient', 'The accessibility tree exposes only anonymous groups, which cannot express the current task.', {
          metadata: { app, nodeCount: live.length, groupCount: groups },
        })
      }
      if (named.length === 0) {
        return failedObservation('computer', 'insufficient', 'The accessibility tree exposes no named or actionable elements.', {
          metadata: { app, nodeCount: live.length, unparsed: ax.unparsed.slice(0, 5) },
        })
      }
    }
    if (ax.kind === 'diff') {
      return failedObservation('computer', 'insufficient', 'The provider returned a diff rather than a full tree, which cannot be used to build a candidate set.', {
        metadata: { app, hint: 'Capture with disableDiff, or capture the same app twice so the diff can be merged onto the first capture.' },
      })
    }
    return okObservation('computer', { app, ax, text }, {
      summary: `${app} · ${live.length} node(s) · ${addressable.length} actionable · ${named.length} named`
        + `${ax.window === undefined ? '' : ` · window "${ax.window}"`}`,
      metadata: {
        app,
        nodeCount: live.length,
        actionableCount: addressable.length,
        namedCount: named.length,
        truncated: ax.truncated,
        textChars: text.length,
      },
    })
  }

  /**
   * Derive candidates from the tree.
   *
   * Element-addressed candidates carry their AX index, so the provider chooses
   * a *meaning* (`open the download`, `reveal in Finder`) and the index never
   * leaves this adapter.
   */
  #candidatesFor(ax: AxCapture): ComputerActionCandidate[] {
    if (this.#config.candidates !== undefined) return this.#config.candidates.slice(0, this.#config.maxCandidates)
    const candidates: ComputerActionCandidate[] = []
    const seen = new Set<string>()
    const push = (candidate: ComputerActionCandidate): void => {
      if (candidates.length >= this.#config.maxCandidates) return
      if (seen.has(candidate.id)) return
      seen.add(candidate.id)
      candidates.push(candidate)
    }
    for (const node of ax.nodes) {
      if (candidates.length >= this.#config.maxCandidates) break
      if (node.removed || node.disabled) continue
      const label = labelOf(node)
      // Editable controls first: `set_value` is the reliable action for them,
      // and the daemon's own report is what says they are writable.
      if (isSettable(node)) {
        push({
          id: `set-${slug(label)}-${node.index}`,
          description: `Set the value of "${label}" (${node.role})`,
          action: { kind: 'set_value', elementIndex: node.index, value: '' },
          metadata: { role: node.role, index: node.index, settable: true },
        })
        continue
      }
      if (isAddressable(node)) {
        const actions = node.secondaryActions.length === 0 ? '' : ` — supports ${node.secondaryActions.join(', ')}`
        push({
          id: `click-${slug(label)}-${node.index}`,
          description: `Click "${label}" (${node.role})${actions}`,
          action: { kind: 'click', elementIndex: node.index },
          metadata: {
            role: node.role,
            index: node.index,
            ...node.secondaryActions.length === 0 ? {} : { secondaryActions: node.secondaryActions },
          },
        })
        continue
      }
      if (isPassive(node)) continue
    }
    return candidates
  }
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

/** Re-exported so a custom environment can reuse the same node vocabulary. */
export type { AxCapture, AxNode }
