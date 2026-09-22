/**
 * E/F. Custom-environment integration test — a game refactored into an
 * `EnvironmentAdapter`, proving the whole point of the architecture:
 *
 * ```text
 * Game state
 *   ↓
 * CustomEnvironmentAdapter
 *   ↓
 * DecisionRequest
 *   ↓
 * DecisionEngine
 *   ↓
 * DecisionProvider        ← swaps without touching the adapter
 *   ↓
 * DecisionResult
 *   ↓
 * Game action
 * ```
 *
 * The "provider" here is a local heuristic over the game state. It is a real
 * provider: it declares capabilities, receives the protocol request, and
 * returns the protocol result. Swapping it for Laya — or for anything else — is
 * a registry change; the adapter below is untouched, which is exactly what the
 * second half of this file asserts.
 *
 * @module dsh-decision-engine/tests/integration/game-adapter.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DecisionEngine } from '../../src/core/decision-engine.ts'
import { DecisionProviderRegistry } from '../../src/core/provider-registry.ts'
import { EnvironmentRegistry } from '../../src/environments/registry.ts'
import { CustomEnvironmentAdapter } from '../../src/environments/custom/adapter.ts'
import { DecisionRuntime } from '../../src/runtime/runner.ts'
import type { DecisionCapability, DecisionProvider, DecisionRequest, DecisionResult } from '../../src/core/types.ts'
import { ScriptedProvider } from '../helpers.ts'

/** The game's own state shape. The adapter never exposes it to the engine verbatim. */
interface SnakeState {
  width: number
  height: number
  head: { x: number; y: number }
  body: { x: number; y: number }[]
  food: { x: number; y: number }
  alive: boolean
  score: number
}

/** A tiny deterministic Snake the test can drive without a browser or a canvas. */
class SnakeGame {
  state: SnakeState
  readonly moves: string[] = []
  #rng = 12345

  constructor() {
    this.state = {
      width: 12,
      height: 12,
      head: { x: 6, y: 6 },
      body: [{ x: 6, y: 7 }, { x: 6, y: 8 }],
      food: { x: 6, y: 2 },
      alive: true,
      score: 0,
    }
  }

  /** The structured state interface the environment exposes — no pixels involved. */
  snapshot(): SnakeState & { availableActions: string[] } {
    const blocked = new Set(this.state.body.map(segment => `${segment.x},${segment.y}`))
    const actions = ['up', 'down', 'left', 'right'].filter((action) => {
      const next = this.#step(this.state.head, action)
      const inside = next.x >= 0 && next.y >= 0 && next.x < this.state.width && next.y < this.state.height
      return inside && !blocked.has(`${next.x},${next.y}`)
    })
    return { ...this.state, availableActions: actions }
  }

  apply(action: string): { ok: boolean; message: string; state: SnakeState & { availableActions: string[] } } {
    this.moves.push(action)
    const safe = this.snapshot().availableActions.includes(action)
    if (!safe) {
      this.state.alive = false
      return { ok: false, message: `move ${action} is not available`, state: this.snapshot() }
    }
    const next = this.#step(this.state.head, action)
    this.state.body = [this.state.head, ...this.state.body.slice(0, -1)]
    this.state.head = next
    if (next.x === this.state.food.x && next.y === this.state.food.y) {
      this.state.score += 1
      this.state.food = this.#nextFood()
    }
    return { ok: true, message: `moved ${action}`, state: this.snapshot() }
  }

  #step(head: { x: number; y: number }, action: string): { x: number; y: number } {
    if (action === 'up') return { x: head.x, y: head.y - 1 }
    if (action === 'down') return { x: head.x, y: head.y + 1 }
    if (action === 'left') return { x: head.x - 1, y: head.y }
    return { x: head.x + 1, y: head.y }
  }

  #nextFood(): { x: number; y: number } {
    const taken = new Set(this.state.body.map(segment => `${segment.x},${segment.y}`))
    for (let attempt = 0; attempt < 200; attempt += 1) {
      this.#rng = (this.#rng * 1103515245 + 12345) % 2147483648
      const x = this.#rng % this.state.width
      this.#rng = (this.#rng * 1103515245 + 12345) % 2147483648
      const y = this.#rng % this.state.height
      if (!taken.has(`${x},${y}`)) return { x, y }
    }
    return { x: 0, y: 0 }
  }
}

/** Build the game environment adapter over the game's structured interface. */
function snakeEnvironment(game: SnakeGame): CustomEnvironmentAdapter<ReturnType<SnakeGame['snapshot']>> {
  return new CustomEnvironmentAdapter({
    id: 'snake',
    observe: () => game.snapshot(),
    candidates: state => state.availableActions.map(action => ({
      id: action,
      description: `Move ${action}`,
      action: { action },
    })),
    execute: candidate => game.apply(String(candidate.action?.action ?? candidate.id)),
    isDone: state => state.alive === false || state.score >= 3,
    summarize: state => `score ${state.score}, head ${state.head.x},${state.head.y}, food ${state.food.x},${state.food.y}`,
    defaultObjective: 'Eat as much food as possible without dying.',
  })
}

/**
 * A provider that plays Snake with a local rule. It sees only the protocol
 * request — objective, candidate descriptions, structured state — which is the
 * same thing any decision model would see.
 */
class HeuristicSnakeProvider implements DecisionProvider {
  readonly id = 'snake-heuristic'
  readonly capabilities: readonly DecisionCapability[] = ['choice', 'ranking', 'score', 'classification']
  readonly requests: DecisionRequest[] = []

  decide(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request)
    const state = request.state as { head?: { x: number; y: number }; food?: { x: number; y: number } }
    const head = state.head ?? { x: 0, y: 0 }
    const food = state.food ?? head
    const scored = request.candidates.map((candidate) => {
      const direction = candidate.id
      const delta = direction === 'up'
        ? { x: 0, y: -1 }
        : direction === 'down'
          ? { x: 0, y: 1 }
          : direction === 'left'
            ? { x: -1, y: 0 }
            : { x: 1, y: 0 }
      const after = { x: head.x + delta.x, y: head.y + delta.y }
      const distance = Math.abs(after.x - food.x) + Math.abs(after.y - food.y)
      return { id: candidate.id, score: -distance }
    })
    const ranked = [...scored].sort((left, right) => right.score - left.score)
    const best = ranked[0]
    return Promise.resolve({
      provider: this.id,
      mode: 'choice',
      ...best === undefined ? {} : { selected: best.id },
      ranking: ranked,
      confidence: 0.7,
      latencyMs: 1,
    })
  }
}

function buildGame(options: { providerId: string; provider?: DecisionProvider }) {
  const game = new SnakeGame()
  const adapter = snakeEnvironment(game)
  const environments = new EnvironmentRegistry()
  environments.register(adapter)
  const registry = new DecisionProviderRegistry()
  const provider = options.provider ?? new HeuristicSnakeProvider()
  registry.register(provider, { enabled: true, config: {} })
  const engine = new DecisionEngine({ defaultProviderId: options.providerId }, registry)
  const runtime = new DecisionRuntime(engine, {
    environments,
    config: { maxSteps: 12, noProgressLimit: 6, repeatedDecisionLimit: 4 },
  })
  return { game, adapter, runtime, environments, registry, engine, provider }
}

describe('custom game environment', () => {
  it('produces a protocol request with the game candidates and a structured state', async () => {
    const { adapter, game } = buildGame({ providerId: 'snake-heuristic' })
    const observation = await adapter.observe()
    assert.equal(observation.status, 'ok')
    assert.match(observation.summary ?? '', /score 0/)
    const request = adapter.buildDecisionRequest(observation, { description: 'Eat food.' })
    assert.ok(request.candidates.length > 0)
    assert.ok(request.candidates.every(candidate => /^Move (up|down|left|right)$/.test(candidate.description)))
    const state = request.state as Record<string, unknown>
    assert.ok('head' in state && 'food' in state)
    assert.ok(game.moves.length === 0, 'building a request must not move the game')
  })

  it('plays the game through the runtime', async () => {
    const { runtime, game } = buildGame({ providerId: 'snake-heuristic' })
    const outcome = await runtime.run({
      environment: 'snake',
      objective: { description: 'Eat as much food as possible without dying.' },
      mode: 'bounded-loop',
    })
    assert.ok(game.moves.length > 0, 'the runtime must have moved the snake')
    assert.ok(['done', 'needs_escalation'].includes(outcome.status))
  })

  it('hands the provider no tool names and no environment internals', async () => {
    const { runtime, provider } = buildGame({ providerId: 'snake-heuristic' })
    await runtime.run({ environment: 'snake', objective: { description: 'Eat.' }, mode: 'single-step' })
    const heuristic = provider as HeuristicSnakeProvider
    const serialized = JSON.stringify(heuristic.requests)
    for (const forbidden of ['browser_', 'computer_use_', 'snake.apply', 'screenshot']) {
      assert.ok(!serialized.includes(forbidden), `provider request leaked "${forbidden}"`)
    }
  })

  it('never lets the provider emit an action directly', async () => {
    // A provider that returns an id the adapter never offered must fail mapping,
    // not reach the game.
    const rogue = new ScriptedProvider({
      id: 'rogue',
      plan: () => ({ provider: 'rogue', mode: 'choice', selected: 'teleport', latencyMs: 1 }),
    })
    const { runtime, game } = buildGame({ providerId: 'rogue', provider: rogue })
    const outcome = await runtime.run({ environment: 'snake', objective: { description: 'Eat.' }, mode: 'single-step' })
    assert.equal(outcome.status, 'needs_escalation')
    assert.ok(['unknown_candidate', 'invalid_decision'].includes(outcome.escalation?.reason ?? ''))
    assert.deepEqual(game.moves, [], 'an unmappable decision must not move the game')
  })

  it('swaps the provider without touching the adapter', async () => {
    // Same adapter class, same construction — only the registry entry changes.
    // This is the architectural claim, executed.
    const heuristic = buildGame({ providerId: 'snake-heuristic' })
    const replacement = new ScriptedProvider({
      id: 'second-provider',
      plan: (request) => ({
        provider: 'second-provider',
        mode: 'choice',
        ...request.candidates[0] === undefined ? {} : { selected: request.candidates[0].id },
        confidence: 0.9,
        latencyMs: 1,
      }),
    })
    const swapped = buildGame({ providerId: 'second-provider', provider: replacement })
    assert.equal(heuristic.adapter.constructor, swapped.adapter.constructor)

    const first = await heuristic.runtime.run({ environment: 'snake', objective: { description: 'Eat.' }, mode: 'single-step' })
    const second = await swapped.runtime.run({ environment: 'snake', objective: { description: 'Eat.' }, mode: 'single-step' })
    assert.equal(first.decision?.provider, 'snake-heuristic')
    assert.equal(second.decision?.provider, 'second-provider')
    assert.equal(first.action?.kind, second.action?.kind, 'the mapped action vocabulary is unchanged')
  })

  it('escalates instead of guessing when the game exposes no structured state', async () => {
    const adapter = new CustomEnvironmentAdapter<never>({
      id: 'blind-game',
      observe: () => undefined,
      candidates: [{ id: 'a', description: 'A' }],
      execute: () => ({ ok: true }),
    })
    const environments = new EnvironmentRegistry()
    environments.register(adapter)
    const registry = new DecisionProviderRegistry()
    registry.register(new HeuristicSnakeProvider(), { enabled: true, config: {} })
    const engine = new DecisionEngine({ defaultProviderId: 'snake-heuristic' }, registry)
    const runtime = new DecisionRuntime(engine, { environments })
    const outcome = await runtime.run({ environment: 'blind-game', objective: { description: 'Play.' }, mode: 'bounded-loop' })
    assert.equal(outcome.status, 'needs_escalation')
    assert.equal(outcome.escalation?.reason, 'insufficient_observation')
  })
})
