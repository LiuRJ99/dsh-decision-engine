/**
 * Real-model verification: load the Laya ONNX bundle and answer real decision
 * requests through the provider.
 *
 * This is the measurable answer to "does the provider actually work", and it
 * reports the one number the architecture is about: provider latency, isolated
 * from environment latency.
 *
 * It resolves the optional SDK and the model bundle from the ambient machine,
 * in this order:
 *
 * 1. `DSH_LAYA_SDK` — path to an installed `@receptron/laya` package directory.
 * 2. `DSH_LAYA_SDK_FROM` — a project directory whose node_modules contains it.
 * 3. a plain `@receptron/laya` import (when the profile provides it).
 * 4. sibling workspace checkouts that have it installed, when `DSH_LAYA_SDK_FROM`
 *    is not set (searched relative to this checkout, never hard-coded).
 *
 * Model bundle: `LAYA_MODEL_DIR`, else `~/.cache/receptron-laya/receptron--laya-onnx/main`
 * when that directory contains `laya.onnx`.
 *
 * Usage:
 *   node examples/verify-real-laya.mjs                 # all four modes
 *   node examples/verify-real-laya.mjs --mode choice   # one mode
 *   node examples/verify-real-laya.mjs --repeat 5      # latency samples
 *
 * Never prints state or model output that could contain user data: the states
 * here are synthetic.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LayaDecisionProvider } from '../lib/providers/laya/index.js'

/** Sibling project directory names to probe for an installed SDK. */
const WORKSPACE_SIBLINGS = ['laya-router', 'laya', 'dsh-laya-router']

/** Resolve the optional SDK without requiring it as a dependency. */
async function loadSdk() {
  const candidates = []
  if (process.env.DSH_LAYA_SDK) candidates.push(resolve(process.env.DSH_LAYA_SDK))
  if (process.env.DSH_LAYA_SDK_FROM) candidates.push(resolve(process.env.DSH_LAYA_SDK_FROM, 'node_modules/@receptron/laya'))
  candidates.push(resolve(import.meta.dirname, '../node_modules/@receptron/laya'))
  // Sibling checkouts in the same workspace: searched generically so no machine
  // path is baked into this repository.
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
    const module = await import(pathToFileURL(entry).href)
    return { module, dir }
  }
  try {
    return { module: await import('@receptron/laya'), dir: 'ambient' }
  } catch {
    return undefined
  }
}

/** Resolve a local ONNX bundle directory, or undefined to let the SDK decide. */
function resolveModelDir() {
  if (process.env.LAYA_MODEL_DIR) return process.env.LAYA_MODEL_DIR
  const cacheRoot = process.env.LAYA_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'receptron-laya')
  const revision = process.env.LAYA_REVISION ?? 'main'
  const sub = process.env.LAYA_SUBFOLDER ? `${process.env.LAYA_SUBFOLDER}/` : ''
  const dir = join(cacheRoot, 'receptron--laya-onnx', revision, sub)
  return existsSync(join(dir, 'laya.onnx')) ? dir : undefined
}

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const MODES = {
  choice: {
    objective: 'Choose the next step after a download finished.',
    state: {
      app: 'Finder',
      window: 'Download',
      visibleText: 'Download complete',
      controls: ['Open', 'Show in Finder', 'Close'],
    },
    candidates: [
      { id: 'open', description: 'Open the downloaded file' },
      { id: 'reveal', description: 'Show the file in Finder' },
      { id: 'close', description: 'Dismiss the dialog' },
    ],
  },
  ranking: {
    objective: 'Rank the recovery steps for a failed upload.',
    state: { step: 'upload', status: 'failed', httpStatus: 502, attempts: 1, retryAfter: null },
    candidates: [
      { id: 'retry', description: 'Retry the upload immediately' },
      { id: 'wait', description: 'Wait for the server to recover, then retry' },
      { id: 'shrink', description: 'Compress the file and retry' },
      { id: 'abort', description: 'Give up and report the failure' },
    ],
  },
  score: {
    objective: 'Rate how good each move is for the snake.',
    state: { head: { x: 6, y: 6 }, food: { x: 6, y: 2 }, dangerAhead: false, length: 3 },
    candidates: [
      { id: 'up', description: 'Move up toward the food' },
      { id: 'left', description: 'Move left along the wall' },
      { id: 'down', description: 'Move down away from the food' },
    ],
  },
  classification: {
    objective: 'Decide whether the snake must change direction now.',
    state: { head: { x: 0, y: 5 }, nextCell: 'wall', food: { x: 4, y: 5 } },
    candidates: [
      { id: 'turn', description: 'Turn away from the wall' },
      { id: 'straight', description: 'Continue straight' },
    ],
  },
}

async function main() {
  const sdk = await loadSdk()
  if (sdk === undefined) {
    console.error('The optional SDK @receptron/laya was not found.')
    console.error('Set DSH_LAYA_SDK (package dir) or DSH_LAYA_SDK_FROM (project dir) and retry.')
    process.exitCode = 2
    return
  }
  const modelDir = resolveModelDir()
  const mode = argOf('mode')
  const repeat = Number(argOf('repeat', '1'))

  console.log(`SDK:      ${sdk.dir}`)
  console.log(`modelDir: ${modelDir ?? '(SDK default cache/download resolution)'}`)

  const provider = new LayaDecisionProvider({
    config: {
      modelDir,
      device: process.env.LAYA_EP ?? 'cpu',
      ...process.env.LAYA_THREADS ? { threads: Number(process.env.LAYA_THREADS) } : {},
      classificationBinaryMode: process.env.LAYA_NOUL === '1' ? 'noul' : 'choice',
    },
    loadModule: async () => sdk.module,
  })

  const loadStarted = Date.now()
  const health = await provider.healthCheck()
  console.log(`health:   ${health.status}${health.reason === undefined ? '' : ` (${health.reason})`}`)
  void loadStarted

  const modes = mode === undefined ? Object.keys(MODES) : [mode]
  const samples = []
  for (const name of modes) {
    const spec = MODES[name]
    if (spec === undefined) {
      console.error(`unknown mode "${name}"; expected one of ${Object.keys(MODES).join(', ')}`)
      process.exitCode = 1
      return
    }
    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const started = Date.now()
      try {
          const started = Date.now()
        const result = await provider.decide({ ...spec, mode: name }, { debug: true })
        const wallMs = Date.now() - started
        samples.push({ mode: name, providerMs: result.latencyMs, wallMs, confidence: result.confidence })
        const ranked = (result.ranking ?? []).map(entry => `${entry.id}${entry.score === undefined ? '' : `=${entry.score.toFixed(3)}`}`).join(' > ')
        console.log(
          `${name.padEnd(15)} selected=${String(result.selected).padEnd(8)} `
          + `confidence=${result.confidence === undefined ? 'n/a' : result.confidence.toFixed(3)} `
          + `providerMs=${String(result.latencyMs).padStart(5)} wallMs=${String(wallMs).padStart(5)}  ranking: ${ranked}`,
        )
        if (result.debug?.notes !== undefined && result.debug.notes.length > 0) {
          console.log(`${' '.repeat(16)}notes: ${result.debug.notes.join(' | ')}`)
        }
      } catch (error) {
        console.error(`${name.padEnd(15)} FAILED: ${error?.message ?? error}`)
        process.exitCode = 1
      }
    }
  }

  console.log('')
  console.log('confidence vs the default engine floor (0.55), for the gates that apply it:')
  for (const sample of samples) {
    if (sample.mode !== 'choice' && sample.mode !== 'classification') continue
    const verdict = (sample.confidence ?? 0) >= 0.55 ? 'would act' : 'would escalate (low_confidence)'
    console.log(`  ${sample.mode.padEnd(15)} confidence=${sample.confidence === undefined ? 'n/a' : sample.confidence.toFixed(3)} → ${verdict}`)
  }
  console.log('  (ranking and score modes are not confidence-gated: a rating is not a choice.)')

  const stats = provider.runtime.stats
  console.log('')
  console.log(`calls=${stats.calls} failures=${stats.failures} inputTokens=${stats.inputTokens}`)
  const providerTimes = samples.map(sample => sample.providerMs).sort((left, right) => left - right)
  if (providerTimes.length > 0) {
    const median = providerTimes[Math.floor(providerTimes.length / 2)]
    console.log(
      `provider latency ms: min=${providerTimes[0]} median=${median} max=${providerTimes.at(-1)} `
      + `(n=${providerTimes.length}, loadMs=${provider.runtime.loadMs})`,
    )
  }
  console.log(`isolation:  core/env layers measured separately by examples/bench-latency.mjs`)
  await provider.dispose()
}

await main()
