/**
 * Plugin-driven environment protocol. The executor reads state and applies
 * actions directly; a main agent never relays individual frames or moves.
 */
import { randomUUID } from 'node:crypto'
import { DecisionError } from '../../core/errors.ts'
import type { DecisionCandidate, DecisionRequest, DecisionResult } from '../../core/types.ts'
import { validateRequest } from '../../core/validate.ts'
import type { ActionResult, EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, Observation, ObserveInput } from '../types.ts'

export const ENVIRONMENT_PROTOCOL = 'dsh-environment/v1' as const

export interface EnvironmentSnapshot {
  protocol: typeof ENVIRONMENT_PROTOCOL
  environmentId: string
  episodeId: string
  revision: string
  state: string | Record<string, unknown>
  candidates: Array<DecisionCandidate & { risky?: boolean }>
  done: boolean
  /** Authoritative final outcome, for example { score: 120, outcome: 'won' }. */
  result?: Record<string, unknown>
}

export interface EnvironmentActionRequest {
  protocol: typeof ENVIRONMENT_PROTOCOL
  actionId: string
  environmentId: string
  episodeId: string
  revision: string
  candidateId: string
}

export interface HttpEnvironmentOptions {
  /** Base URL exposing GET state and POST action. */
  endpoint: string
  id?: string
  headers?: Record<string, string>
  /** For trusted embedders/tests; DSH uses the standard fetch transport. */
  fetch?: typeof globalThis.fetch
}

export class HttpEnvironmentAdapter implements EnvironmentAdapter {
  readonly id: string
  readonly source = 'custom' as const
  readonly capabilities = ['observe', 'execute', 'terminal-result'] as const
  readonly #base: URL
  readonly #headers: Record<string, string>
  readonly #fetch: typeof globalThis.fetch
  readonly #observations = new WeakMap<Observation, EnvironmentSnapshot>()
  readonly #actions = new WeakMap<EnvironmentAction, EnvironmentActionRequest>()
  #identity: { environmentId: string; episodeId: string } | undefined

  constructor(options: HttpEnvironmentOptions) {
    let base: URL
    try { base = new URL(options.endpoint) } catch {
      throw new DecisionError('invalid_request', 'Environment endpoint must be an absolute HTTP(S) URL.')
    }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new DecisionError('invalid_request', 'Environment endpoint must use HTTP(S), without credentials, query, or fragment.')
    }
    base.pathname = `${base.pathname.replace(/\/$/, '')}/`
    this.#base = base
    this.id = options.id ?? `http:${base.href}`
    this.#headers = options.headers ?? {}
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async observe(input?: ObserveInput): Promise<Observation> {
    return this.#observation(await this.#request('state', { method: 'GET', ...input?.signal === undefined ? {} : { signal: input.signal } }))
  }

  buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest {
    const snapshot = this.#requireSnapshot(observation)
    return {
      objective: objective.description, state: snapshot.state,
      candidates: snapshot.candidates.map(({ id, description, metadata }) => ({ id, description, ...metadata === undefined ? {} : { metadata } })),
      ...objective.constraints === undefined ? {} : { constraints: objective.constraints },
      metadata: { environment: snapshot.environmentId, episodeId: snapshot.episodeId, revision: snapshot.revision },
    }
  }

  mapDecision(decision: DecisionResult, observation: Observation): EnvironmentAction {
    const snapshot = this.#requireSnapshot(observation)
    const candidate = snapshot.candidates.find(entry => entry.id === decision.selected)
    if (candidate === undefined) throw new DecisionError('unknown_candidate', 'The selected action was not offered by this snapshot.')
    const action: EnvironmentAction = {
      kind: 'custom', candidateId: candidate.id, description: candidate.description,
      ...candidate.risky === true ? { risky: true } : {},
    }
    this.#actions.set(action, {
      protocol: ENVIRONMENT_PROTOCOL, actionId: randomUUID(), environmentId: snapshot.environmentId,
      episodeId: snapshot.episodeId, revision: snapshot.revision, candidateId: candidate.id,
    })
    return action
  }

  async execute(action: EnvironmentAction, input?: ExecuteInput): Promise<ActionResult> {
    const request = this.#actions.get(action)
    if (request === undefined) throw new DecisionError('action_mapping_failed', 'The action was not mapped by this environment.')
    if (action.risky && !input?.allowRisky) throw new DecisionError('high_risk_action', 'This action requires confirmation.')
    if (input?.signal?.aborted) throw new DecisionError('aborted', 'The environment action was cancelled.')
    const response = await this.#request('action', {
      method: 'POST', body: JSON.stringify(request),
      ...input?.signal === undefined ? {} : { signal: input.signal },
    })
    if (!isRecord(response) || typeof response.ok !== 'boolean') throw new DecisionError('action_execution_failed', 'Action response must contain ok and observation.')
    if (!response.ok) return { ok: false, message: typeof response.message === 'string' ? response.message : 'The environment rejected the action.' }
    const observation = this.#observation(response.observation)
    return {
      ok: true, observation, done: observation.done === true,
      ...observation.result === undefined ? {} : { result: observation.result },
      ...typeof response.message === 'string' ? { message: response.message } : {},
    }
  }

  isDone(observation: Observation): boolean { return observation.done === true }

  #requireSnapshot(observation: Observation): EnvironmentSnapshot {
    const snapshot = this.#observations.get(observation)
    if (snapshot === undefined) throw new DecisionError('insufficient_observation', 'The observation does not belong to this environment.')
    return snapshot
  }

  #observation(value: unknown): Observation {
    if (!isRecord(value) || value.protocol !== ENVIRONMENT_PROTOCOL || typeof value.done !== 'boolean'
      || !['environmentId', 'episodeId', 'revision'].every(key => typeof value[key] === 'string' && value[key] !== '')
      || !Array.isArray(value.candidates) || (typeof value.state !== 'string' && !isRecord(value.state))
      || (value.result !== undefined && !isRecord(value.result))) {
      throw new DecisionError('insufficient_observation', 'Invalid dsh-environment/v1 snapshot.')
    }
    const snapshot = value as unknown as EnvironmentSnapshot
    // A finished episode is allowed to expose no further actions.
    if (!snapshot.done || snapshot.candidates.length > 0) validateRequest({ state: snapshot.state, candidates: snapshot.candidates })
    if (this.#identity !== undefined && (this.#identity.environmentId !== snapshot.environmentId || this.#identity.episodeId !== snapshot.episodeId)) {
      throw new DecisionError('environment_unavailable', 'The environment or episode changed during the task; refusing to control a different game.')
    }
    this.#identity = { environmentId: snapshot.environmentId, episodeId: snapshot.episodeId }
    const observation: Observation = {
      status: 'ok', source: this.source, state: snapshot.state, done: snapshot.done,
      ...snapshot.result === undefined ? {} : { result: snapshot.result },
      metadata: { environmentId: snapshot.environmentId, episodeId: snapshot.episodeId, revision: snapshot.revision },
    }
    this.#observations.set(observation, snapshot)
    return observation
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#base), {
      ...init, redirect: 'error', headers: { ...this.#headers, accept: 'application/json', 'content-type': 'application/json' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new DecisionError(path === 'action' ? 'action_execution_failed' : 'environment_unavailable',
        `Environment ${path} returned HTTP ${response.status}; actions are not automatically retried.`)
    }
    return response.json()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
