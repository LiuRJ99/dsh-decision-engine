/**
 * Latency benchmark: the one number the architecture exists to protect.
 *
 * It measures each layer **separately**, because "the browser felt slow" and
 * "the model is slow" are different problems with different fixes:
 *
 * - provider latency — inside the decision provider;
 * - decision latency — provider + engine validation/routing/normalization;
 * - observation latency — the environment's structured-state read;
 * - mapping latency — decision → concrete environment action;
 * - execution latency — the action itself;
 * - total latency — the whole `observe → decide → map → execute → verify` step.
 *
 * The environment here is synthetic and fast on purpose: the point is to bound
 * the *layer's own* overhead, not to benchmark a browser. Run
 * `examples/verify-real-laya.mjs` for real provider numbers.
 *
 * Usage:
 *   node examples/bench-latency.mjs
 *   node examples/bench-latency.mjs --iterations 500
 *   node examples/bench-latency.mjs --json
 */
import { createDecisionEngineComposition } from '../lib/composition.js'
import { CustomEnvironmentAdapter } from '../lib/environments/custom/adapter.js'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const iterations = Number(argOf('iterations', '200'))
const asJson = process.argv.includes('--json')

/** A provider with a fixed, tiny amount of work: it just orders the candidates. */
const fixedProvider = {
  id: 'fixed',
  capabilities: ['choice', 'ranking', 'score', 'classification'],
  decide: (request) => Promise.resolve({
    provider: 'fixed',
    mode: request.mode ?? 'choice',
    selected: request.candidates[0]?.id,
    ranking: request.candidates.map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.1 })),
    confidence: 0.8,
    confidenceKind: 'provider_raw',
    latencyMs: 0,
  }),
}

/** A game environment with an in-memory state: the cheapest possible "world". */
function benchEnvironment() {
  let ticks = 0
  return new CustomEnvironmentAdapter({
    id: 'bench',
    observe: () => {
      ticks += 1
      return { ticks, health: 100, enemyHealth: 100, availableActions: ['attack', 'defend', 'heal', 'flee'] }
    },
    candidates: state => state.availableActions.map(action => ({ id: action, description: `Perform ${action}` })),
    execute: () => ({ ok: true, message: 'ok' }),
    isDone: () => false,
  })
}

/** Percentiles from a list of millisecond samples. */
function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1)
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(mean),
  }
}

const round = (value) => Math.round(value * 1000) / 1000

async function main() {
  const composition = createDecisionEngineComposition({
    config: {
      defaultProvider: 'fixed',
      providers: { laya: { enabled: false } },
      browser: { enabled: false },
      computer: { enabled: false },
      // The ring buffer must hold every step record this run produces, or the
      // slowest samples would be silently dropped from the report.
      telemetryLimit: iterations * 2 + 16,
    },
    dispatcher: { call: () => Promise.resolve({ ok: false, text: '', error: 'this benchmark uses no host tools' }) },
    extraProviders: [{ provider: fixedProvider }],
  })
  const environment = benchEnvironment()
  composition.environments.register(environment)

  const providerMs = []
  const decisionMs = []
  const stepTimings = { observeMs: [], mapMs: [], executeMs: [], totalMs: [] }

  // Warm up the JIT so the first sample does not dominate the mean.
  for (let index = 0; index < 20; index += 1) {
    await composition.service.decide({
      objective: 'Pick an action.',
      state: { health: 100 },
      candidates: [{ id: 'attack', description: 'Attack' }, { id: 'defend', description: 'Defend' }],
    })
  }

  for (let index = 0; index < iterations; index += 1) {
    const decisionStarted = process.hrtime.bigint()
    const result = await composition.service.decide({
      objective: 'Pick an action.',
      state: { health: 100, enemyHealth: 100 },
      candidates: [
        { id: 'attack', description: 'Attack' },
        { id: 'defend', description: 'Defend' },
        { id: 'heal', description: 'Heal' },
      ],
    })
    decisionMs.push(Number(process.hrtime.bigint() - decisionStarted) / 1e6)
    providerMs.push(result.latencyMs)
  }

  const runtime = composition.runtime
  for (let index = 0; index < iterations; index += 1) {
    await runtime.run({
      environment: 'bench',
      objective: { description: 'Survive.' },
      mode: 'single-step',
      config: { maxDurationMs: 60_000 },
    })
  }
  for (const record of composition.telemetryRecords.slice(-iterations)) {
    if (record.kind !== 'step') continue
    stepTimings.observeMs.push(record.timings.observeMs ?? 0)
    stepTimings.mapMs.push(record.timings.mapMs ?? 0)
    stepTimings.executeMs.push(record.timings.executeMs ?? 0)
    stepTimings.totalMs.push(record.timings.totalMs)
  }

  const report = {
    iterations,
    provider: stats(providerMs),
    engineDecision: stats(decisionMs),
    engineOverhead: stats(decisionMs.map((value, index) => value - (providerMs[index] ?? 0))),
    environmentObserve: stats(stepTimings.observeMs),
    actionMap: stats(stepTimings.mapMs),
    actionExecute: stats(stepTimings.executeMs),
    stepTotal: stats(stepTimings.totalMs),
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`iterations: ${iterations} (synthetic provider + in-memory environment)`)
    console.log('')
    console.log('layer                 n     min     p50     p90     p99     max    mean   (ms)')
    for (const [label, value] of [
      ['provider.decide', report.provider],
      ['engine.decide', report.engineDecision],
      ['engine overhead', report.engineOverhead],
      ['environment.observe', report.environmentObserve],
      ['action.map', report.actionMap],
      ['action.execute', report.actionExecute],
      ['step total', report.stepTotal],
    ]) {
      console.log(
        `${label.padEnd(20)}${String(value.n).padStart(4)}${String(value.min).padStart(8)}${String(value.p50).padStart(8)}`
        + `${String(value.p90).padStart(8)}${String(value.p99).padStart(8)}${String(value.max).padStart(8)}${String(value.mean).padStart(8)}`,
      )
    }
    console.log('')
    console.log('Reading this table: `engine overhead` is what the layer itself costs on top of the')
    console.log('provider; a large `environment.observe` with a fast provider means the environment is')
    console.log('the slow part, not the decision model.')
  }

  await composition.dispose()
}

await main()
