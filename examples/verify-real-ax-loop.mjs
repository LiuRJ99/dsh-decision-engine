/**
 * Computer smoke test over a REAL accessibility tree — the closed loop:
 *
 * ```text
 * listApps                (real daemon)
 *   ↓
 * get_app_state           (real AX capture — no screenshot read)
 *   ↓
 * ComputerAdapter.observe (real adapter)
 *   ↓
 * DecisionRequest         (real candidate derivation)
 *   ↓
 * DecisionEngine → Laya   (real ONNX provider, loaded from the local bundle)
 *   ↓
 * MappedAction            (element index; NOT executed)
 * ```
 *
 * Nothing is clicked. The point is the success path through the environment
 * side, which the mock integration tests cannot cover: that a real AX capture
 * becomes a real observation, a real finite candidate set, a real decision, and
 * a real mapped action.
 *
 * Requirements: macOS, the computer-use daemon installed and permitted
 * (Accessibility), and an app that the daemon can target — take the id from
 * `--list`.
 *
 * Usage:
 *   node examples/verify-real-ax-loop.mjs --list
 *   node examples/verify-real-ax-loop.mjs --app com.apple.TextEdit
 *   node examples/verify-real-ax-loop.mjs --app com.apple.TextEdit --no-laya   # skip the model
 *
 * Exit codes: 0 pass, 1 the loop did not complete, 2 prerequisites missing.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const app = argOf('app')
const listOnly = process.argv.includes('--list')
const skipLaya = process.argv.includes('--no-laya')
const objective = argOf('objective', 'Find the control that moves this text editing task forward.')

/** Candidate host roots, nearest first. */
function hostRoots() {
  const roots = [join(import.meta.dirname, '../node_modules')]
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of ['', 'web', 'web-candidate']) roots.push(join(home, 'profiles', profile, 'node_modules'))
  try {
    const dshBin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (dshBin !== '') {
      let dir = dirname(dshBin)
      for (let depth = 0; depth < 6; depth += 1) {
        roots.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
        roots.push(join(dir, 'node_modules'))
        dir = dirname(dir)
      }
    }
  } catch {
    // `which dsh` unavailable; the earlier roots still apply.
  }
  return roots
}

const REQUIRED = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt']
const hostRoot = hostRoots().find(root => REQUIRED.every(specifier => existsSync(join(root, specifier, 'lib/index.js'))))
if (hostRoot === undefined) {
  console.error('The host packages are not resolvable from here; run from the repository root.')
  process.exitCode = 2
  process.exit()
}
const load = specifier => import(pathToFileURL(join(hostRoot, specifier, 'lib/index.js')).href)
const { Context } = await load('@deepseek-ai/cordis')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { ComputerEnvironmentAdapter } = await import('../lib/environments/computer/adapter.js')
const { DecisionEngine } = await import('../lib/core/index.js')
const { DecisionRuntime } = await import('../lib/runtime/index.js')
const { EnvironmentRegistry } = await import('../lib/environments/registry.js')

/** Locate a package that may live in a different node_modules tree. */
function findPackage(specifier) {
  const probes = [join(hostRoot, specifier, 'lib/index.js'), join(import.meta.dirname, '../node_modules', specifier, 'lib/index.js')]
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of ['', 'web', 'web-candidate']) probes.push(join(home, 'profiles', profile, 'node_modules', specifier, 'lib/index.js'))
  return probes.find(probe => existsSync(probe))
}

function computerPackageDir() {
  if (process.env.DSH_COMPUTER_PACKAGE) return process.env.DSH_COMPUTER_PACKAGE
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of ['web', 'web-candidate']) {
    for (const dir of [
      join(home, 'profiles', profile, 'node_modules/@zibokapi/dsh-codex-computer-use'),
      join(home, 'profiles/node_modules/@zibokapi/dsh-codex-computer-use'),
    ]) {
      if (existsSync(join(dir, 'lib/computer-local/index.js'))) return dir
    }
  }
  return undefined
}

/** Build the real ctx.computer seam in a real Cordis context. */
async function buildSeam() {
  const dir = computerPackageDir()
  if (dir === undefined) return { error: 'the computer-use package was not found in an installed profile' }
  const subprocessPath = findPackage('@deepseek-ai/dsh-subprocess-local')
  if (subprocessPath === undefined) return { error: 'dsh-subprocess-local is not installed in any probed node_modules tree' }
  const subprocessModule = await import(pathToFileURL(subprocessPath).href)
  const SubprocessRuntime = subprocessModule.LocalSubprocessRuntime ?? subprocessModule.default
  const { LocalComputerEngine } = await import(pathToFileURL(join(dir, 'lib/computer-local/index.js')).href)
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new SubprocessRuntime(ctx)
  const engine = new LocalComputerEngine(ctx, {
    helperPath: process.env.DSH_COMPUTER_HELPER_PATH,
    helperArgs: [],
    timeoutMs: 30_000,
    maxTimeoutMs: 60_000,
    maxTreeBytes: 4_000_000,
    maxScreenshotBytes: 4_000_000,
    graceMs: 1_000,
    foregroundApps: [],
    browserIsolation: false,
    browserUrlAllow: [],
    browserUrlDeny: [],
    deniedApps: [],
  })
  return { engine, dir, ctx }
}

/** Locate the optional Laya SDK and bundle the same way the other scripts do. */
async function loadLaya() {
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
  let module
  let dir
  for (const candidate of candidates) {
    const entry = join(candidate, 'dist/index.js')
    if (!existsSync(entry)) continue
    module = await import(pathToFileURL(entry).href)
    dir = candidate
    break
  }
  if (module === undefined) return undefined
  const cacheRoot = process.env.LAYA_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'receptron-laya')
  const modelDir = process.env.LAYA_MODEL_DIR ?? join(cacheRoot, 'receptron--laya-onnx', process.env.LAYA_REVISION ?? 'main', process.env.LAYA_SUBFOLDER ? `${process.env.LAYA_SUBFOLDER}/` : '')
  return { module, dir, modelDir: existsSync(join(modelDir, 'laya.onnx')) ? modelDir : undefined }
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- seam ------------------------------------------------------------------
const seamResult = await buildSeam()
if (seamResult.engine === undefined) {
  console.error(`Could not build the ctx.computer seam: ${seamResult.error}`)
  console.error('This smoke test needs macOS, the computer-use plugin installed, and Accessibility permission.')
  process.exitCode = 2
  process.exit()
}
console.log(`seam: ${seamResult.dir}`)
console.log('')

if (listOnly || app === undefined) {
  const apps = await seamResult.engine.listApps(seamResult.engine.resolve({ order: 'usage' }))
  console.log(`targetable apps: ${apps.length}`)
  console.log('name | bundle id | running | uses')
  for (const entry of apps) {
    console.log(`${entry.displayName ?? '?'} | ${entry.id} | ${entry.isRunning === true ? 'yes' : 'no'} | ${entry.useCount ?? '-'}`)
  }
  if (app === undefined && !listOnly) {
    console.log('')
    console.error('Pass --app <bundle id or display name> to run the loop.')
    process.exitCode = 2
  }
  process.exit()
}

// --- adapter ---------------------------------------------------------------
const adapter = new ComputerEnvironmentAdapter({
  seam: seamResult.engine,
  config: { app, maxCandidates: 8, captureTimeoutMs: 30_000 },
})

const startedObservation = Date.now()
const observation = await adapter.observe()
const observeMs = Date.now() - startedObservation
console.log(`observed ${app} in ${observeMs}ms`)
console.log(`  status:  ${observation.status}`)
if (observation.summary !== undefined) console.log(`  summary: ${observation.summary}`)
if (observation.reason !== undefined) console.log(`  reason:  ${observation.reason}`)
check('a real AX capture produced an ok observation', observation.status === 'ok', observation.summary)

if (observation.status !== 'ok') {
  console.log('')
  console.log('The loop stopped at the observation, which is the designed behavior for an')
  console.log('environment that cannot express the task as structured state.')
  console.log('Pick another app from --list, or grant Accessibility permission.')
  console.log('')
  console.log(`0/1 checks passed`)
  process.exitCode = 1
  process.exit()
}

const metadata = observation.metadata ?? {}
console.log(`  nodes:   ${metadata.nodeCount ?? '?'} (${metadata.actionableCount ?? '?'} actionable, ${metadata.namedCount ?? '?'} named)`)
const treeText = observation.state?.text ?? ''
console.log('')
console.log('real AX tree (first 25 lines):')
for (const line of String(treeText).split('\n').slice(0, 25)) console.log(`  ${line}`)

// --- decision request ------------------------------------------------------
const request = adapter.buildDecisionRequest(observation, { description: objective })
console.log('')
console.log(`candidates derived from the real tree: ${request.candidates.length}`)
for (const candidate of request.candidates.slice(0, 8)) console.log(`  - ${candidate.id}: ${candidate.description}`)
check('the real tree yielded a finite candidate set', request.candidates.length > 0, `${request.candidates.length} candidate(s)`)
const serializedState = JSON.stringify(request.state)
check('the screenshot never entered the decision state', !serializedState.includes('screenshot'))

// --- decision (real Laya, unless skipped) ----------------------------------
const environments = new EnvironmentRegistry()
environments.register(adapter)

if (skipLaya) {
  console.log('')
  console.log('--no-laya: skipping the model; the loop reached a real DecisionRequest.')
  console.log('')
  const passed = results.filter(result => result.ok).length
  console.log(`${passed}/${results.length} checks passed`)
  process.exitCode = passed === results.length ? 0 : 1
  process.exit()
}

const laya = await loadLaya()
if (laya === undefined) {
  console.error('')
  console.error('The Laya SDK was not found (set DSH_LAYA_SDK); re-run with --no-laya to check the environment side only.')
  process.exitCode = 2
  process.exit()
}
console.log('')
console.log(`laya: ${laya.dir}`)
console.log(`model: ${laya.modelDir ?? '(SDK default bundle resolution)'}`)

const { LayaDecisionProvider, DecisionRuntime: _unused } = { LayaDecisionProvider: (await import('../lib/providers/laya/index.js')).LayaDecisionProvider, DecisionRuntime: undefined }
void _unused
const provider = new LayaDecisionProvider({
  config: { modelDir: laya.modelDir, device: process.env.LAYA_EP ?? 'cpu' },
  loadModule: async () => laya.module,
})
const engine = new DecisionEngine({ defaultProviderId: 'laya' })
engine.registry.register(provider, { enabled: true, config: {} })
const runtime = new DecisionRuntime(engine, { environments, config: { maxSteps: 1 } })

const outcome = await runtime.run({
  environment: 'computer',
  objective: { description: objective },
  mode: 'decision-only',
})

console.log('')
console.log(`decision:  ${outcome.decision?.selected ?? '(none)'}`)
console.log(`provider:  ${outcome.decision?.provider ?? '(none)'}`)
console.log(`confidence: ${outcome.decision?.confidence === undefined ? 'n/a' : outcome.decision.confidence.toFixed(3)} (${outcome.decision?.confidenceKind ?? 'unlabelled'})`)
console.log(`action:    ${outcome.action?.kind ?? '(none)'} target=${String(outcome.action?.target ?? '-')} — ${outcome.action?.description ?? ''}`)
if (outcome.escalation !== undefined) console.log(`escalated: ${outcome.escalation.reason} — ${outcome.escalation.guidance}`)

check('the real AX tree produced a real decision', outcome.decision?.selected !== undefined, String(outcome.decision?.selected))
check('the decision mapped to an element-indexed desktop action', outcome.action !== undefined && typeof outcome.action.target === 'number', `${outcome.action?.kind} target=${String(outcome.action?.target)}`)
check('decision-only executed nothing', outcome.status === 'decided', `status=${outcome.status}`)

await provider.dispose()
console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.label}`)
}
