/**
 * Confidence calibration against the real Laya model.
 *
 * The question this answers: with the provider's dominance-based normalization,
 * does the engine's default `confidenceThreshold: 0.55` separate "the model
 * picked something" from "the model is torn"? It runs the same state through
 * the real ONNX bundle twice, with genuinely different levels of ambiguity, and
 * prints both Laya's own entropy confidence and the provider's normalized
 * confidence side by side.
 *
 * The entropy column is there to show **why** the normalization exists: it
 * barely moves between a clear and a torn decision, because it mostly measures
 * how many options were on the ballot.
 *
 * Usage:
 *   node examples/laya-confidence-calibration.mjs
 *   node examples/laya-confidence-calibration.mjs --repeat 3
 *
 * SDK and bundle discovery match `verify-real-laya.mjs`; nothing is hard-coded
 * to a machine path.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LayaDecisionProvider } from '../lib/providers/laya/index.js'

const WORKSPACE_SIBLINGS = ['laya-router', 'laya', 'dsh-laya-router']

async function loadSdk() {
  const candidates = []
  if (process.env.DSH_LAYA_SDK) candidates.push(resolve(process.env.DSH_LAYA_SDK))
  if (process.env.DSH_LAYA_SDK_FROM) candidates.push(resolve(process.env.DSH_LAYA_SDK_FROM, 'node_modules/@receptron/laya'))
  candidates.push(resolve(import.meta.dirname, '../node_modules/@receptron/laya'))
  for (const depth of ['..', '../..', '../../..', '../../../..', '../../../../..']) {
    for (const parent of ['', 'gitproject', 'work', 'projects']) {
      for (const project of WORKSPACE_SIBLINGS) {
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

/**
 * Two three-option decisions over the SAME candidates: one where the state
 * makes a single action clearly right, one where two actions are equally
 * defensible. Comparing them isolates ambiguity from option count.
 */
const CASES = [
  {
    label: 'clear',
    expectation: 'one option dominates',
    objective: 'Advance the download dialog now that the file has finished downloading.',
    state: {
      app: 'Finder',
      window: 'Download',
      visibleText: 'Download complete. The file is ready to open.',
      controls: ['Open', 'Show in Finder', 'Close'],
      userIntent: 'wants to look at the downloaded file',
    },
    candidates: [
      { id: 'open', description: 'Open the downloaded file so the user can read it' },
      { id: 'reveal', description: 'Show the file in Finder without opening it' },
      { id: 'close', description: 'Dismiss the dialog and open nothing' },
    ],
  },
  {
    label: 'torn',
    expectation: 'two options are near-equivalent',
    objective: 'Advance the download dialog now that the file has finished downloading.',
    state: {
      app: 'Finder',
      window: 'Download',
      visibleText: 'Download complete. The file is ready to open.',
      controls: ['Open', 'Show in Finder', 'Close'],
      userIntent: 'unknown; the user has said nothing about what they want next',
      note: 'both Open and Show in Finder are equally reasonable, and the user has not expressed a preference',
    },
    candidates: [
      { id: 'open', description: 'Open the downloaded file so the user can read it' },
      { id: 'reveal', description: 'Show the file in Finder without opening it; equally reasonable when intent is unknown' },
      { id: 'reveal-folder', description: 'Reveal the containing folder instead of the file; also reasonable' },
    ],
  },
]

/** Laya's own entropy confidence, recomputed here from the raw distribution. */
function entropyConfidence(probabilities) {
  const entries = Object.entries(probabilities ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
  if (entries.length < 2) return undefined
  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  if (total <= 0) return undefined
  let entropy = 0
  for (const [, value] of entries) {
    const p = value / total
    if (p > 0) entropy -= p * Math.log(p)
  }
  return 1 - entropy / Math.log(entries.length)
}

async function main() {
  const sdk = await loadSdk()
  if (sdk === undefined) {
    console.error('The optional SDK @receptron/laya was not found (set DSH_LAYA_SDK).')
    process.exitCode = 2
    return
  }
  const repeat = Number(process.argv.includes('--repeat') ? process.argv[process.argv.indexOf('--repeat') + 1] : '1')

  const provider = new LayaDecisionProvider({
    config: { modelDir: resolveModelDir(), device: process.env.LAYA_EP ?? 'cpu' },
    loadModule: async () => sdk.module,
  })

  console.log(`SDK:      ${sdk.dir}`)
  console.log(`floor:    engine default confidenceThreshold = 0.55`)
  console.log('')

  const rows = []
  for (const testCase of CASES) {
    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const result = await provider.decide({
        objective: testCase.objective,
        state: testCase.state,
        candidates: testCase.candidates,
        mode: 'choice',
      }, { debug: true })
      const probabilities = result.debug?.raw?.select?.probabilities ?? {}
      rows.push({
        label: testCase.label,
        expectation: testCase.expectation,
        selected: result.selected,
        normalized: result.confidence,
        kind: result.confidenceKind,
        raw: result.debug?.rawConfidence,
        entropy: entropyConfidence(probabilities),
        probabilities,
      })
    }
  }

  console.log('case   selected        normalized  kind        layaEntropy  P(top)  distribution')
  for (const row of rows) {
    const top = Math.max(...Object.values(row.probabilities).filter(value => typeof value === 'number'), 0)
    const distribution = Object.entries(row.probabilities)
      .map(([id, value]) => `${id}=${typeof value === 'number' ? value.toFixed(3) : String(value)}`)
      .join(' ')
    console.log(
      `${row.label.padEnd(6)} ${String(row.selected).padEnd(15)} `
      + `${row.normalized === undefined ? '   n/a' : row.normalized.toFixed(3).padStart(6)}  `
      + `${String(row.kind).padEnd(11)} `
      + `${row.entropy === undefined ? '    n/a' : row.entropy.toFixed(3).padStart(10)}  `
      + `${top.toFixed(3).padStart(6)}  ${distribution}`,
    )
  }

  console.log('')
  console.log('gate outcome at threshold 0.55 (what the engine would do):')
  for (const row of rows) {
    const verdict = row.normalized === undefined
      ? 'no comparable confidence → engine does not gate'
      : row.normalized >= 0.55
        ? 'would act'
        : 'would escalate (low_confidence)'
    console.log(`  ${row.label.padEnd(6)} normalized=${row.normalized === undefined ? 'n/a' : row.normalized.toFixed(3)} → ${verdict}`)
  }

  const clear = rows.filter(row => row.label === 'clear' && row.normalized !== undefined)
  const torn = rows.filter(row => row.label === 'torn' && row.normalized !== undefined)
  console.log('')
  if (clear.length > 0 && torn.length > 0) {
    const clearMean = clear.reduce((sum, row) => sum + row.normalized, 0) / clear.length
    const tornMean = torn.reduce((sum, row) => sum + row.normalized, 0) / torn.length
    console.log(`separation: clear mean ${clearMean.toFixed(3)} vs torn mean ${tornMean.toFixed(3)} (gap ${(clearMean - tornMean).toFixed(3)})`)
    console.log(clearMean > tornMean
      ? 'The normalization separates the two cases, so threshold 0.55 is meaningful on this scale.'
      : 'The normalization does NOT separate the two cases; the threshold needs recalibration.')
  } else {
    console.log('Not enough usable samples to compare; re-run with --repeat.')
  }

  await provider.dispose()
}

await main()
