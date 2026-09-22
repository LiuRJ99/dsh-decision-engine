/**
 * A runnable custom-environment demo: Snake driven end to end through the
 * decision layer, with a *swappable* provider.
 *
 * The point is not to play Snake well. It is to show the boundary in motion:
 * the same `CustomEnvironmentAdapter` works with a local heuristic provider and
 * with Laya, and the game code never learns which one answered.
 *
 * Usage:
 *   node examples/demo-custom-game.mjs                    # heuristic provider
 *   node examples/demo-custom-game.mjs --provider laya    # real Laya, if present
 *   node examples/demo-custom-game.mjs --steps 30 --quiet
 *
 * When `--provider laya` is requested but the SDK or model bundle is missing,
 * the demo says so and exits 2 rather than silently falling back — a fallback
 * that hides itself is how a "real model" claim stops being true.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDecisionEngineComposition } from '../lib/composition.js'
import { CustomEnvironmentAdapter } from '../lib/environments/custom/adapter.js'
import { LayaDecisionProvider } from '../lib/providers/laya/index.js'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const providerName = argOf('provider', 'heuristic')
const maxSteps = Number(argOf('steps', '24'))
const quiet = process.argv.includes('--quiet')

/** A deterministic 12x12 Snake that exposes structured state and nothing else. */
class Snake {
  constructor() {
    this.width = 12
    this.height = 12
    this.head = { x: 6, y: 6 }
    this.body = [{ x: 6, y: 7 }, { x: 6, y: 8 }]
    this.food = { x: 6, y: 2 }
    this.alive = true
    this.score = 0
    this.moves = []
    this.#rng = 987654321
  }

  #rng

  /** The structured interface the environment adapter consumes. */
  snapshot() {
    const blocked = new Set(this.body.map(segment => `${segment.x},${segment.y}`))
    const availableActions = ['up', 'down', 'left', 'right'].filter((action) => {
      const next = this.#step(this.head, action)
      const inside = next.x >= 0 && next.y >= 0 && next.x < this.width && next.y < this.height
      return inside && !blocked.has(`${next.x},${next.y}`)
    })
    return {
      head: this.head,
      food: this.food,
      length: this.body.length,
      score: this.score,
      alive: this.alive,
      availableActions,
    }
  }

  apply(action) {
    const state = this.snapshot()
    if (!state.availableActions.includes(action)) {
      this.alive = false
      return { ok: false, message: `illegal move ${action}`, state: this.snapshot() }
    }
    this.moves.push(action)
    const next = this.#step(this.head, action)
    this.body = [this.head, ...this.body.slice(0, -1)]
    this.head = next
    if (next.x === this.food.x && next.y === this.food.y) {
      this.score += 1
      this.body.push({ ...this.body.at(-1) })
      this.food = this.#nextFood()
    }
    return { ok: true, message: `moved ${action}`, state: this.snapshot() }
  }

  #step(head, action) {
    if (action === 'up') return { x: head.x, y: head.y - 1 }
    if (action === 'down') return { x: head.x, y: head.y + 1 }
    if (action === 'left') return { x: head.x - 1, y: head.y }
    return { x: head.x + 1, y: head.y }
  }

  #nextFood() {
    const taken = new Set(this.body.map(segment => `${segment.x},${segment.y}`))
    for (let attempt = 0; attempt < 500; attempt += 1) {
      this.#rng = (this.#rng * 1103515245 + 12345) % 2147483648
      const x = this.#rng % this.width
      this.#rng = (this.#rng * 1103515245 + 12345) % 2147483648
      const y = this.#rng % this.height
      if (!taken.has(`${x},${y}`)) return { x, y }
    }
    return { x: 0, y: 0 }
  }
}

/** Provider 1: a local rule. Not a model — a baseline, and a fast one. */
const heuristicProvider = {
  id: 'snake-heuristic',
  capabilities: ['choice', 'ranking', 'score', 'classification'],
  decide(request) {
    const state = request.state
    const head = state.head ?? { x: 0, y: 0 }
    const food = state.food ?? head
    const ranked = request.candidates
      .map((candidate) => {
        const delta = candidate.id === 'up'
          ? { x: 0, y: -1 }
          : candidate.id === 'down'
            ? { x: 0, y: 1 }
            : candidate.id === 'left'
              ? { x: -1, y: 0 }
              : { x: 1, y: 0 }
        const distance = Math.abs(head.x + delta.x - food.x) + Math.abs(head.y + delta.y - food.y)
        return { id: candidate.id, score: -distance }
      })
      .sort((left, right) => right.score - left.score)
    return Promise.resolve({
      provider: 'snake-heuristic',
      mode: request.mode ?? 'choice',
      selected: ranked[0]?.id,
      ranking: ranked,
      confidence: 0.6,
      confidenceKind: 'provider_raw',
      latencyMs: 0,
    })
  },
}

/** Locate the optional SDK the same way `verify-real-laya.mjs` does. */
async function loadSdk() {
  const candidates = []
  if (process.env.DSH_LAYA_SDK) candidates.push(resolve(process.env.DSH_LAYA_SDK))
  if (process.env.DSH_LAYA_SDK_FROM) candidates.push(resolve(process.env.DSH_LAYA_SDK_FROM, 'node_modules/@receptron/laya'))
  candidates.push(resolve(import.meta.dirname, '../node_modules/@receptron/laya'))
  for (const depth of ['..', '../..', '../../..', '../../../..', '../../../../..']) {
    for (const parent of ['', 'gitproject', 'work', 'projects']) {
      for (const project of ['laya-router', 'laya', 'dsh-laya-router']) {
        candidates.push(resolve(import.meta.dirname, depth, parent, project, 'node_modules/@receptron/laya'))
      }
    }
  }
  for (const dir of candidates) {
    const entry = join(dir, 'dist/index.js')
    if (!existsSync(entry)) continue
    return { module: await import(pathToFileURL(entry).href), dir }
  }
  return undefined
}

function resolveModelDir() {
  if (process.env.LAYA_MODEL_DIR) return process.env.LAYA_MODEL_DIR
  const cacheRoot = process.env.LAYA_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'receptron-laya')
  const dir = join(cacheRoot, 'receptron--laya-onnx', process.env.LAYA_REVISION ?? 'main', process.env.LAYA_SUBFOLDER ? `${process.env.LAYA_SUBFOLDER}/` : '')
  return existsSync(join(dir, 'laya.onnx')) ? dir : undefined
}

async function main() {
  const game = new Snake()
  const environment = new CustomEnvironmentAdapter({
    id: 'snake',
    observe: () => game.snapshot(),
    candidates: state => state.availableActions.map(action => ({ id: action, description: `Move ${action}` })),
    execute: candidate => game.apply(String(candidate.action?.action ?? candidate.id)),
    isDone: state => state.alive === false || state.score >= 5,
    summarize: state => `score ${state.score} · head ${state.head.x},${state.head.y} · food ${state.food.x},${state.food.y}`,
    defaultObjective: 'Eat as much food as possible without dying.',
  })

  const extraProviders = []
  if (providerName === 'laya') {
    const sdk = await loadSdk()
    if (sdk === undefined) {
      console.error('--provider laya requested, but @receptron/laya was not found (set DSH_LAYA_SDK).')
      process.exitCode = 2
      return
    }
    const modelDir = resolveModelDir()
    console.log(`loading Laya (${modelDir ?? 'SDK default bundle resolution'}) …`)
    extraProviders.push({
      provider: new LayaDecisionProvider({
        config: { modelDir, device: process.env.LAYA_EP ?? 'cpu' },
        loadModule: async () => sdk.module,
      }),
    })
  } else {
    extraProviders.push({ provider: heuristicProvider })
  }

  const composition = createDecisionEngineComposition({
    config: {
      defaultProvider: providerName === 'laya' ? 'laya' : 'snake-heuristic',
      providers: { laya: { enabled: providerName === 'laya' } },
      browser: { enabled: false },
      computer: { enabled: false },
      runtime: { maxSteps, repeatedDecisionLimit: maxSteps, noProgressLimit: maxSteps },
      telemetryLimit: maxSteps + 8,
    },
    dispatcher: { call: () => Promise.resolve({ ok: false, text: '', error: 'the demo uses no host tools' }) },
    extraProviders,
  })
  composition.environments.register(environment)

  const outcome = await composition.runtime.run({
    environment: 'snake',
    objective: { description: 'Eat as much food as possible without dying.' },
    mode: 'bounded-loop',
    config: { maxSteps },
  })

  if (!quiet) {
    for (const record of composition.telemetryRecords) {
      const timings = record.timings
      console.log(
        `step ${String(record.step ?? 0).padStart(2)}  ${String(record.selected ?? '?').padEnd(6)} `
        + `conf=${record.confidence === undefined ? '  n/a' : record.confidence.toFixed(3)} `
        + `decide=${(timings.decisionMs ?? 0).toFixed(1)}ms `
        + `map=${(timings.mapMs ?? 0).toFixed(1)}ms `
        + `exec=${(timings.executeMs ?? 0).toFixed(1)}ms`,
      )
    }
  }

  console.log('')
  console.log(`provider:     ${providerName}`)
  console.log(`status:       ${outcome.status}${outcome.escalation === undefined ? '' : ` (${outcome.escalation.reason})`}`)
  console.log(`moves:        ${game.moves.join(' ') || '(none)'}`)
  console.log(`final state:  score=${game.score} alive=${game.alive} head=${game.head.x},${game.head.y}`)
  if (outcome.escalation !== undefined) console.log(`guidance:     ${outcome.escalation.guidance}`)

  await composition.dispose()
}

await main()
