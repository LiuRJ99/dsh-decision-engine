/**
 * Which Laya head actually discriminates? A measurement, not a guess.
 *
 * The choice head turns out to be diffuse on every state tested (top ≈0.65,
 * runner-up margin ≈0.43), and its own entropy confidence barely moves between a
 * clear decision and a torn one. Before choosing a normalization, this script
 * asks a more basic question: **does any Laya head separate clear from torn,
 * and by how much?**
 *
 * It runs three heads over the same two states:
 *
 * - `choice`   — softmax over the candidates;
 * - `score`    — an ordered rating per candidate (Laya's own scale);
 * - `noul`     — a binary judgement whose P(true) this script samples per
 *                candidate, giving a second, independent ranking signal.
 *
 * For each head it reports the separation between the clear and torn states plus
 * the head's natural range across all probed states — the numbers a calibration
 * would have to be based on.
 *
 * Usage:
 *   node examples/laya-head-calibration.mjs
 *   node examples/laya-head-calibration.mjs --repeat 4   # stability across identical calls
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

const CANDIDATES = [
  { id: 'open', description: 'Open the downloaded file so the user can read it' },
  { id: 'reveal', description: 'Show the file in Finder without opening it' },
  { id: 'close', description: 'Dismiss the dialog and open nothing' },
]

const STATES = [
  {
    label: 'clear',
    objective: 'Advance the download dialog now that the file has finished downloading.',
    state: {
      app: 'Finder',
      window: 'Download',
      visibleText: 'Download complete. The file is ready to open.',
      userIntent: 'wants to look at the downloaded file',
    },
  },
  {
    label: 'torn',
    objective: 'Advance the download dialog now that the file has finished downloading.',
    state: {
      app: 'Finder',
      window: 'Download',
      visibleText: 'Download complete. The file is ready to open.',
      userIntent: 'unknown; the user has said nothing about what they want next',
      note: 'both Open and Show in Finder are equally reasonable, and the user has not expressed a preference',
    },
  },
  {
    label: 'impossible',
    objective: 'Advance the download dialog now that the file has finished downloading.',
    state: {
      app: 'Finder',
      window: 'Download',
      visibleText: 'Download complete. The file is ready to open.',
      userIntent: 'contradictory: the user wants the file opened and also wants nothing opened',
    },
  },
  {
    label: 'unrelated',
    objective: 'Advance the download dialog now that the file has finished downloading.',
    state: { weather: 'rainy', stockPrice: 42, unrelatedCounter: 7 },
  },
]

async function main() {
  const sdk = await loadSdk()
  if (sdk === undefined) {
    console.error('The optional SDK @receptron/laya was not found (set DSH_LAYA_SDK).')
    process.exitCode = 2
    return
  }
  const { Laya } = sdk.module
  const instance = await Laya.load({ ...resolveModelDir() === undefined ? {} : { modelDir: resolveModelDir() } })
  const config = instance.config ?? {}
  console.log(`SDK:      ${sdk.dir}`)
  console.log(`config:   max_len=${config.max_len ?? '?'} head_max_len=${config.head_max_len ?? '?'}`)
  console.log(`temperature: ${JSON.stringify(config.temperature ?? null)}`)
  console.log(`temperature_by_options keys: ${Object.keys(config.temperature_by_options ?? {}).length}`)
  console.log('')

  const repeated = Number(process.argv.includes('--repeat') ? process.argv[process.argv.indexOf('--repeat') + 1] : '1')
  const rows = []
  for (const entry of STATES) {
    const stateText = JSON.stringify(entry.state)
    const criteria = Object.fromEntries(CANDIDATES.map(candidate => [candidate.id, candidate.description]))

    // --- choice head, repeated: is the distribution even stable per state? ---
    const runs = []
    for (let iteration = 0; iteration < repeated; iteration += 1) {
      const choice = await instance.systemOne(stateText, {
        select: { type: 'choice', instructions: `Objective: ${entry.objective}`, criteria },
      })
      const answer = choice.answers.select ?? {}
      const probabilities = answer.probabilities ?? {}
      const sorted = Object.entries(probabilities).sort((left, right) => right[1] - left[1])
      const top = sorted[0]?.[1] ?? 0
      const second = sorted[1]?.[1] ?? 0
      const total = sorted.reduce((sum, [, value]) => sum + value, 0) || 1
      runs.push({
        selected: answer.choice,
        top,
        margin: top - second,
        dominance: (top - second) / total,
        entropy: entropy(probabilities),
        sdkConfidence: typeof answer.confidence === 'number' ? answer.confidence : undefined,
        probabilities,
      })
    }
    const choice = runs[0]
    const answer = { choice: choice?.selected, confidence: choice?.sdkConfidence }
    const probabilities = choice?.probabilities ?? {}
    const top = choice?.top ?? 0
    const second = top - (choice?.margin ?? 0)
    const dominance = choice?.dominance ?? 0
    if (runs.length > 1) {
      console.log(`${entry.label}: choice runs → ${runs.map(run => `${run.selected}/${run.top.toFixed(3)}/d${run.dominance.toFixed(3)}`).join('  ')}`)
    }
    const spreadAcrossRuns = runs.length > 1 ? Math.max(...runs.map(r => r.dominance)) - Math.min(...runs.map(r => r.dominance)) : 0
    void spreadAcrossRuns

    // --- score head, one question per candidate, in one forward pass ---
    const scoreQuestions = {}
    for (const candidate of CANDIDATES) {
      scoreQuestions[`rate::${candidate.id}`] = {
        type: 'score',
        instructions: `Objective: ${entry.objective}\nRate the option "${candidate.id}": ${candidate.description}`,
        criteria: ['a very poor choice', 'a poor choice', 'an acceptable choice', 'a good choice', 'a very good choice'],
      }
    }
    const scored = await instance.systemOne(stateText, scoreQuestions)
    const levels = {}
    for (const candidate of CANDIDATES) {
      const value = scored.answers[`rate::${candidate.id}`]?.score
      levels[candidate.id] = typeof value === 'number' ? value : null
    }
    const rated = Object.values(levels).filter(value => typeof value === 'number')
    const scoreSpread = rated.length >= 2 ? Math.max(...rated) - Math.min(...rated) : undefined
    const scoreTop = rated.length > 0 ? Math.max(...rated) : undefined

    // --- noul head, one binary question per candidate pair against the first ---
    const noulQuestions = {}
    for (const candidate of CANDIDATES.slice(1)) {
      noulQuestions[`vs::${candidate.id}`] = {
        type: 'noul',
        instructions: `Objective: ${entry.objective}\nIs "${CANDIDATES[0].id}" a better next action than "${candidate.id}"?`,
        criteria: { true: CANDIDATES[0].description, false: candidate.description },
      }
    }
    const judged = await instance.systemOne(stateText, noulQuestions)
    const noul = Object.fromEntries(Object.entries(judged.answers).map(([key, value]) => [key, value?.noul ?? null]))

    rows.push({
      label: entry.label,
      runs,
      choice: { selected: answer.choice, top, second, dominance, entropy: entropy(probabilities) },
      score: { levels, top: scoreTop, spread: scoreSpread },
      noul,
    })
  }

  console.log('CHOICE head (SDK confidence = entropy confidence)')
  console.log('state       selected  P(top)  margin  dominance  entropy  sdkConf')
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(11)} ${String(row.choice.selected).padEnd(9)} `
      + `${row.choice.top.toFixed(3).padStart(6)}  ${(row.choice.top - row.choice.second).toFixed(3).padStart(6)}  `
      + `${row.choice.dominance.toFixed(3).padStart(9)}  ${row.choice.entropy === undefined ? '  n/a' : row.choice.entropy.toFixed(3)}  `
      + `${row.runs[0]?.sdkConfidence === undefined ? '  n/a' : row.runs[0].sdkConfidence.toFixed(3)}`,
    )
  }

  console.log('')
  console.log('SCORE head (level 0..4 per candidate)')
  console.log('state       open  reveal  close   top  spread')
  for (const row of rows) {
    const values = CANDIDATES.map(candidate => row.score.levels[candidate.id])
    console.log(
      `${row.label.padEnd(11)} ${values.map(value => (value === null ? ' n/a' : String(value).padStart(4))).join('  ')}  `
      + `${row.score.top === undefined ? 'n/a' : String(row.score.top).padStart(3)}  ${row.score.spread === undefined ? ' n/a' : String(row.score.spread).padStart(6)}`,
    )
  }

  console.log('')
  console.log('NOUL head (P(true) that "open" beats the other)')
  console.log('state       vs reveal  vs close')
  for (const row of rows) {
    const values = Object.values(row.noul)
    console.log(`${row.label.padEnd(11)} ${values.map(value => (value === null ? '   n/a' : value.toFixed(3).padStart(8))).join('  ')}`)
  }

  console.log('')
  console.log('choice stability across repeated identical calls (dominance per run):')
  for (const row of rows) {
    const values = row.runs.map(run => run.dominance)
    const min = Math.min(...values)
    const max = Math.max(...values)
    console.log(`  ${row.label.padEnd(11)} ${values.map(value => value.toFixed(3)).join(', ')}  (spread ${(max - min).toFixed(3)})`)
  }

  console.log('')
  console.log('separation between "clear" and "torn":')
  const clear = rows.find(row => row.label === 'clear')
  const torn = rows.find(row => row.label === 'torn')
  if (clear !== undefined && torn !== undefined) {
    console.log(`  choice dominance : ${clear.choice.dominance.toFixed(3)} vs ${torn.choice.dominance.toFixed(3)} → gap ${(clear.choice.dominance - torn.choice.dominance).toFixed(3)}`)
    const clearSpread = clear.score.spread
    const tornSpread = torn.score.spread
    console.log(`  score spread     : ${clearSpread ?? 'n/a'} vs ${tornSpread ?? 'n/a'} → gap ${clearSpread !== undefined && tornSpread !== undefined ? clearSpread - tornSpread : 'n/a'}`)
    const clearNoul = Math.max(...Object.values(clear.noul).filter(value => value !== null))
    const tornNoul = Math.max(...Object.values(torn.noul).filter(value => value !== null))
    console.log(`  noul max P(true): ${clearNoul.toFixed(3)} vs ${tornNoul.toFixed(3)} → gap ${(clearNoul - tornNoul).toFixed(3)}`)
  }

  const scoredHeadSpread = rows.map(row => row.score.spread).filter(value => typeof value === 'number')
  console.log('')
  console.log('natural ranges observed across all probed states:')
  console.log(`  choice dominance : ${rows.map(row => row.choice.dominance.toFixed(3)).join(', ')}`)
  console.log(`  choice P(top)    : ${rows.map(row => row.choice.top.toFixed(3)).join(', ')}`)
  console.log(`  score spread     : ${scoredHeadSpread.length === 0 ? 'n/a' : scoredHeadSpread.join(', ')}`)
  console.log(`  noul P(true)     : ${rows.flatMap(row => Object.values(row.noul).filter(value => value !== null)).map(value => value.toFixed(3)).join(', ')}`)

  await instance.close()
}

function entropy(probabilities) {
  const entries = Object.entries(probabilities ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
  if (entries.length < 2) return undefined
  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  if (total <= 0) return undefined
  let value = 0
  for (const [, probability] of entries) {
    const p = probability / total
    if (p > 0) value -= p * Math.log(p)
  }
  return 1 - value / Math.log(entries.length)
}

await main()
