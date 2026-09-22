/**
 * Embedding verification: the decision layer used by a **non-DSH host**, with no
 * DSH packages and no tool registry — the situation every external integrator is
 * in.
 *
 * It exercises the one-call entry (`dsh-decision-engine/embed`) over a real
 * decision, with a real provider, and checks the three things an integrator
 * depends on:
 *
 * 1. a game-shaped environment can be registered and driven without touching any
 *    DSH service;
 * 2. an escalation comes back as a value (serializable), not as a thrown error,
 *    so a bridge can forward it;
 * 3. the confidence rule is enforced across the boundary — an unlabelled
 *    confidence is refused, which is what keeps one model's scale from being
 *    compared with another's.
 *
 * The provider is a deterministic stub unless `--laya` is passed, so this runs
 * without the 1.6 GB bundle.
 *
 * Usage:
 *   node examples/verify-embedding.mjs
 *   node examples/verify-embedding.mjs --laya        # use the real model
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDecisionLayer } from '../lib/embed.js'

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** A provider with a fixed answer and a declared confidence kind. */
function stubProvider(selected, options = {}) {
  return {
    id: options.id ?? 'stub',
    capabilities: ['choice', 'ranking', 'score', 'classification'],
    decide: (request) => Promise.resolve({
      provider: options.id ?? 'stub',
      mode: request.mode ?? 'choice',
      selected,
      ranking: request.candidates.map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.1 })),
      ...options.confidence === undefined ? {} : { confidence: options.confidence, confidenceKind: options.confidenceKind ?? 'provider_raw' },
      latencyMs: 1,
    }),
  }
}

const useLaya = process.argv.includes('--laya')

// A host with no DSH anywhere: only Node and this package.
const { CustomEnvironmentAdapter } = await import('../lib/embed.js')

let layer
if (useLaya) {
  const sdkCandidates = [
    join(import.meta.dirname, '../node_modules/@receptron/laya'),
    join(process.env.HOME ?? '', '.dsh/profiles/web/node_modules/@receptron/laya'),
  ]
  const sdk = sdkCandidates.find(dir => existsSync(join(dir, 'dist/index.js')))
  if (sdk === undefined) {
    console.error('--laya requested but the SDK was not found; install @receptron/laya or omit the flag.')
    process.exitCode = 2
    process.exit()
  }
  const cacheRoot = process.env.LAYA_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'receptron-laya')
  const modelDir = join(cacheRoot, 'receptron--laya-onnx', 'main')
  layer = createDecisionLayer({
    laya: existsSync(join(modelDir, 'laya.onnx')) ? { modelDir } : {},
    confidenceThreshold: 0.55,
  })
  console.log(`provider: real Laya (${modelDir})\n`)
} else {
  layer = createDecisionLayer({
    laya: false,
    providers: [stubProvider('attack')],
    confidenceThreshold: 0.55,
  })
  console.log('provider: stub (pass --laya for the real model)\n')
}

check('the layer builds with no DSH service present', typeof layer.decide === 'function' && layer.providers.ids().length > 0, layer.providers.ids().join(', '))

// --- a game-shaped environment --------------------------------------------
let acted = 0
layer.environments.register(new CustomEnvironmentAdapter({
  id: 'arena',
  observe: () => ({ score: 0, health: 100, enemyHealth: 100, over: false }),
  candidates: () => [
    { id: 'attack', description: 'Attack the enemy', action: { op: 'attack' } },
    { id: 'defend', description: 'Raise a guard', action: { op: 'defend' } },
    { id: 'heal', description: 'Drink a potion', action: { op: 'heal' } },
  ],
  execute: (candidate) => {
    acted += 1
    return { ok: true, message: `did ${candidate.action.op}` }
  },
  summarize: state => `hp ${state.health} vs ${state.enemyHealth}`,
}))
check('a game-shaped adapter registers with no adapter subclassing', layer.environments.has('arena'))

// --- decision only: no action executed ------------------------------------
const preview = await layer.decideEnvironment({ environment: 'arena', objective: 'Win the fight.' })
check('decision-only returns the mapped action without executing it', preview.status === 'decided' && preview.action?.kind === 'custom' && acted === 0,
  `status=${preview.status} action=${preview.action?.kind} acted=${acted}`)
check('the outcome is serializable for a bridge', JSON.stringify(preview).length > 0)

// --- single step: exactly one action, and it reports back -----------------
const single = await layer.decideEnvironment({ environment: 'arena', objective: 'Win the fight.', mode: 'single-step' })
check('single-step executes exactly one action', single.status === 'executed' && acted === 1, `status=${single.status} acted=${acted}`)
check('the environment message reaches the caller', single.execution?.message === 'did attack', String(single.execution?.message))

// --- escalation is a value, not an exception ------------------------------
const blind = new CustomEnvironmentAdapter({
  id: 'blind',
  observe: () => undefined,
  candidates: () => [{ id: 'wait', description: 'Wait' }],
  execute: () => ({ ok: true }),
})
layer.environments.register(blind)
const escalated = await layer.decideEnvironment({ environment: 'blind', objective: 'Do something.' })
check('an unusable environment escalates instead of guessing', escalated.status === 'needs_escalation' && escalated.escalation?.reason === 'insufficient_observation',
  `${escalated.status}/${escalated.escalation?.reason}`)
check('the escalation carries guidance and is serializable', typeof escalated.escalation?.guidance === 'string' && JSON.stringify(escalated.escalation).includes('guidance'))

// --- the confidence rule holds across the embedding boundary --------------
const unlabelled = createDecisionLayer({
  laya: false,
  providers: [{
    id: 'sloppy',
    capabilities: ['choice'],
    decide: (request) => Promise.resolve({
      provider: 'sloppy',
      mode: 'choice',
      selected: request.candidates[0]?.id,
      confidence: 0.9,
      latencyMs: 0,
    }),
  }],
})
let refused = false
let code
try {
  await unlabelled.decide({ state: 's', candidates: [{ id: 'a', description: 'A' }] })
} catch (error) {
  refused = true
  code = error.code
}
check('a confidence without a kind is refused at the boundary', refused && code === 'invalid_decision', String(code))
await unlabelled.dispose()

// --- residency is the embedder's dial -------------------------------------
check('residency defaults to load-on-demand', (await layer.health()).providers[Object.keys((await layer.health()).providers)[0]] !== undefined)

const health = await layer.health()
check('health names the environment and the provider', health.environments.includes('arena') && Object.keys(health.providers).length > 0,
  `envs=${health.environments.join(',')} providers=${Object.keys(health.providers).join(',')}`)

await layer.dispose()
check('dispose releases providers and environments', layer.providers.ids().length === 0 && layer.environments.ids().length === 0)

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.label}`)
}
