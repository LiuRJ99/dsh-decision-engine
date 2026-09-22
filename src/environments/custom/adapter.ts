/**
 * Custom Environment Adapter.
 *
 * The third environment class: games, internal business systems, device
 * control, simulators — anything that already exposes a structured state
 * interface. It is not a wrapper around a specific game. A game (or simulator,
 * or API) supplies four small callbacks and this adapter turns them into the
 * same protocol the browser and computer adapters speak.
 *
 * That is what makes the boundary real: a Snake adapter and a Tetris adapter
 * are *this* class with different callbacks, and neither of them knows which
 * decision model is answering.
 *
 * ```ts
 * const snake = new CustomEnvironmentAdapter({
 *   id: 'snake',
 *   observe: () => game.snapshot(),              // { score, health, availableActions, … }
 *   candidates: (state) => state.availableActions.map(action => ({ … })),
 *   execute: (action) => game.apply(action.candidateId),
 *   isDone: (state) => state.score > 0 && state.over,
 * })
 * ```
 *
 * @module dsh-decision-engine/environments/custom/adapter
 */

import { DecisionError } from '../../core/errors.ts'
import type { DecisionRequest, DecisionResult } from '../../core/types.ts'
import type { EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, ObserveInput, Observation } from '../types.ts'
import { failedObservation, okObservation } from '../types.ts'

/** One candidate a custom environment offers, plus the action it performs. */
export interface CustomCandidate<State = unknown> {
  id: string
  description: string
  metadata?: Record<string, unknown>
  /** Environment-owned action payload. Passed back to `execute` verbatim. */
  action?: Record<string, unknown>
  /** Whether executing this candidate is externally visible or hard to undo. */
  risky?: boolean
  /** Whether the candidate should be offered for this state. Defaults to always. */
  available?(state: State): boolean
}

/** Result of executing one custom action. */
export interface CustomExecutionResult {
  ok: boolean
  message?: string
  /** Environment state after the action, when the environment reports it cheaply. */
  state?: unknown
  /** Whether the environment now considers the objective met. */
  done?: boolean
}

/** The callbacks a custom environment supplies. */
export interface CustomEnvironmentSpec<State = unknown> {
  /** Stable environment id (`snake`, `tetris`, `line-controller`, …). */
  id: string
  /**
   * Read the environment's current structured state. Returning `undefined`
   * means "no usable structured state right now", which becomes an
   * `insufficient` observation — the environment must not guess.
   */
  observe(input?: ObserveInput): Promise<State | undefined> | State | undefined
  /**
   * The finite candidate set for a state. Either a static array or a function
   * of the state. Candidates whose `available(state)` is false are dropped.
   */
  candidates: CustomCandidate<State>[] | ((state: State) => CustomCandidate<State>[])
  /** Execute the chosen candidate. */
  execute(candidate: CustomCandidate<State>, input?: ExecuteInput): Promise<CustomExecutionResult> | CustomExecutionResult
  /** Whether the objective is already met. Optional. */
  isDone?(state: State, objective: Objective): Promise<boolean> | boolean
  /** Objective text for the provider when the caller did not supply a specific one. */
  defaultObjective?: string
  /** Optional human-readable one-line summary of a state. */
  summarize?(state: State): string
  /** Optional state shaping before it reaches a provider. Defaults to the state itself. */
  projectState?(state: State): unknown
  /** Release held resources. */
  dispose?(): Promise<void> | void
}

/**
 * The custom adapter. Generic over the environment's own state type so the
 * callbacks stay typed on the environment side.
 */
export class CustomEnvironmentAdapter<State = unknown> implements EnvironmentAdapter {
  readonly id: string
  readonly source = 'custom' as const
  readonly capabilities = ['observe', 'buildDecisionRequest', 'mapDecision', 'execute'] as const

  readonly #spec: CustomEnvironmentSpec<State>
  #pending = new Map<string, CustomCandidate<State>>()
  #lastState: State | undefined

  constructor(spec: CustomEnvironmentSpec<State>) {
    if (typeof spec?.id !== 'string' || spec.id.trim() === '') {
      throw new DecisionError('invalid_request', 'A custom environment must declare a non-empty id.')
    }
    if (typeof spec.observe !== 'function') {
      throw new DecisionError('invalid_request', `Custom environment "${spec.id}" must implement observe().`, { subject: spec.id })
    }
    if (typeof spec.execute !== 'function') {
      throw new DecisionError('invalid_request', `Custom environment "${spec.id}" must implement execute().`, { subject: spec.id })
    }
    this.id = spec.id
    this.#spec = spec
  }

  /** Observe the environment. */
  async observe(input?: ObserveInput): Promise<Observation> {
    let state: State | undefined
    try {
      state = await this.#spec.observe(input)
    } catch (error) {
      return failedObservation('custom', 'error', error instanceof Error ? error.message : String(error), { metadata: { environment: this.id } })
    }
    if (state === undefined || state === null) {
      return failedObservation('custom', 'insufficient', `Environment "${this.id}" returned no structured state.`, {
        metadata: { environment: this.id, hint: 'The environment must expose explicit structured state; this layer never guesses.' },
      })
    }
    this.#lastState = state
    return okObservation('custom', state, {
      ...this.#spec.summarize === undefined ? {} : { summary: this.#spec.summarize(state) },
      metadata: { environment: this.id },
    })
  }

  /** Build the decision request from a custom state. */
  buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest {
    if (observation.status !== 'ok') {
      throw new DecisionError('insufficient_observation', `Cannot build a decision request from a ${observation.status} observation.`, {
        subject: this.id,
        details: { reason: observation.reason },
      })
    }
    const state = observation.state as State
    const offered = typeof this.#spec.candidates === 'function' ? this.#spec.candidates(state) : this.#spec.candidates
    const available = offered.filter(candidate => candidate.available === undefined || candidate.available(state))
    if (available.length === 0) {
      throw new DecisionError('no_candidates', `Environment "${this.id}" offers no available action for this state.`, {
        subject: this.id,
        details: { offered: offered.map(candidate => candidate.id) },
      })
    }
    this.#pending = new Map(available.map(candidate => [candidate.id, candidate]))
    const projected = this.#spec.projectState === undefined ? state : this.#spec.projectState(state)
    const objectiveText = objective.description === '' ? this.#spec.defaultObjective : objective.description
    return {
      ...objectiveText === undefined ? {} : { objective: objectiveText },
      state: toDecisionState(projected),
      candidates: available.map(candidate => ({
        id: candidate.id,
        description: candidate.description,
        ...candidate.metadata === undefined ? {} : { metadata: candidate.metadata },
      })),
      ...objective.constraints === undefined ? {} : { constraints: objective.constraints },
      mode: 'choice',
      metadata: { environment: this.id },
    }
  }

  /** Map a chosen candidate id to a custom action. */
  mapDecision(result: DecisionResult, observation: Observation): EnvironmentAction {
    const selected = result.selected
    if (selected === undefined) {
      throw new DecisionError('invalid_decision', `Provider "${result.provider}" returned no selection.`, { subject: result.provider })
    }
    const candidate = this.#pending.get(selected)
    if (candidate === undefined) {
      throw new DecisionError('unknown_candidate', `Decision "${selected}" does not map to an action of environment "${this.id}".`, {
        subject: this.id,
        details: { selected, offered: [...this.#pending.keys()] },
      })
    }
    void observation
    return {
      kind: 'custom',
      candidateId: candidate.id,
      description: candidate.description,
      ...candidate.action === undefined ? {} : { payload: candidate.action },
      ...candidate.risky === true ? { risky: true } : {},
    }
  }

  /** Execute a mapped custom action. */
  async execute(action: EnvironmentAction, input?: ExecuteInput): Promise<CustomExecutionResult> {
    const candidate = this.#pending.get(action.candidateId)
    if (candidate === undefined) {
      throw new DecisionError('unknown_candidate', `Action "${action.candidateId}" was not offered by environment "${this.id}".`, { subject: this.id })
    }
    try {
      return await this.#spec.execute(candidate, input)
    } catch (error) {
      throw new DecisionError('action_execution_failed', error instanceof Error ? error.message : String(error), {
        subject: this.id,
        details: { candidateId: action.candidateId },
        cause: error,
      })
    }
  }

  /** Whether the objective is met, when the environment can tell. */
  isDone(observation: Observation, objective: Objective): Promise<boolean> | boolean {
    if (this.#spec.isDone === undefined) return false
    if (observation.status !== 'ok') return false
    return this.#spec.isDone(observation.state as State, objective)
  }

  /** The environment state seen by the last successful observation. */
  get lastState(): State | undefined {
    return this.#lastState
  }

  async dispose(): Promise<void> {
    await this.#spec.dispose?.()
  }
}

/**
 * Coerce an arbitrary structured state into something the decision protocol
 * accepts. Scalars and arrays are wrapped so a request always carries an
 * object or a string, never `undefined`.
 */
export function toDecisionState(value: unknown): string | Record<string, unknown> {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  if (Array.isArray(value)) return { items: value }
  return { value: value as unknown as null }
}
