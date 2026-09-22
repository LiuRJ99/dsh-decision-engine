/**
 * Manual computer-use verification: observe a real desktop app's accessibility
 * tree and take ONE decision about it, with nothing executed unless `--yes`.
 *
 * This is NOT part of the automated suite. It needs:
 *
 * - macOS Accessibility permission for the computer-use daemon;
 * - an app the user is not actively using;
 * - for `--transport tools`, a running DSH session with `/computer-use` unlocked.
 *
 * Two transports, both real:
 *
 * - `seam` (default): constructs the computer-use plugin's own
 *   `LocalComputerEngine` (`ctx.computer`) inside a real Cordis context, using
 *   the profile's `dsh-subprocess-local` service. This is a genuine AX capture.
 * - `tools`: dispatches `computer_use_*` through a host tool registry, which is
 *   what the decision engine does in production.
 *
 * The decision provider is a deterministic local rule so the output is
 * readable. Swap it for Laya by running `verify-real-laya.mjs` for provider
 * numbers; the point here is the environment side.
 *
 * Usage:
 *   node examples/verify-real-computer.mjs --app "Finder"
 *   node examples/verify-real-computer.mjs --app "Finder" --objective "Close the dialog" --yes
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const app = argOf('app')
const objective = argOf('objective', 'Find the control that moves this task forward.')
const shouldExecute = process.argv.includes('--yes')
const transport = argOf('transport', 'seam')

if (app === undefined) {
  console.error('Pass --app "<display name | bundle id | path>".')
  process.exitCode = 2
  process.exit()
}

/** Candidate host roots, nearest first, requiring one complete installation. */
function hostRoots() {
  const roots = [join(import.meta.dirname, '../node_modules')]
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of ['', 'web', 'web-candidate']) {
    roots.push(join(home, 'profiles', profile, 'node_modules'))
  }
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
    // No `which dsh`; the earlier roots still apply.
  }
  return roots
}

const REQUIRED = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']
const hostRoot = hostRoots().find(root => REQUIRED.every(specifier => existsSync(join(root, specifier, 'lib/index.js'))))
if (hostRoot === undefined) {
  console.error('The host packages are not resolvable from here; run from the repository root.')
  process.exitCode = 2
  process.exit()
}

const load = specifier => import(pathToFileURL(join(hostRoot, specifier, 'lib/index.js')).href)
const { Context } = await load('@deepseek-ai/cordis')
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { DecisionEngine } = await import('../lib/core/index.js')
const { EnvironmentRegistry } = await import('../lib/environments/registry.js')
const { DecisionRuntime } = await import('../lib/runtime/index.js')
const { ComputerEnvironmentAdapter } = await import('../lib/environments/computer/adapter.js')

/** Locate the computer-use plugin's package directory in an installed profile. */
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

/**
 * Locate a package that may live in a different `node_modules` from the cordis
 * core — the profile mirror and the CLI bundle are not identical trees, and
 * requiring one root for every package would reject working installations.
 */
function findPackage(specifier) {
  const probes = [
    join(hostRoot, specifier, 'lib/index.js'),
    join(import.meta.dirname, '../node_modules', specifier, 'lib/index.js'),
  ]
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of ['', 'web', 'web-candidate']) {
    probes.push(join(home, 'profiles', profile, 'node_modules', specifier, 'lib/index.js'))
  }
  return probes.find(probe => existsSync(probe))
}

/** Build the real `ctx.computer` seam inside a real Cordis context. */
async function buildSeam() {
  const dir = computerPackageDir()
  if (dir === undefined) return undefined
  const subprocessPath = findPackage('@deepseek-ai/dsh-subprocess-local')
  if (subprocessPath === undefined) {
    return { error: 'dsh-subprocess-local is not installed in any probed node_modules tree' }
  }

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
  return { engine, dir }
}

const seamResult = transport === 'seam' ? await buildSeam() : undefined
if (transport === 'seam' && seamResult !== undefined && seamResult.error !== undefined) {
  console.error(`Could not build the ctx.computer seam: ${seamResult.error}`)
  console.error('Use --transport tools from a DSH session instead.')
  process.exitCode = 2
  process.exit()
}
if (transport === 'seam' && seamResult?.engine === undefined) {
  console.error('The computer-use plugin was not found in an installed profile.')
  console.error('Set DSH_COMPUTER_PACKAGE to its package directory, or use --transport tools.')
  process.exitCode = 2
  process.exit()
}
if (transport === 'tools') {
  console.error('The tools transport needs a live DSH session: this script has no host registry.')
  console.error('Use the running session instead, or use the default --transport seam.')
  process.exitCode = 2
  process.exit()
}
if (seamResult?.engine !== undefined) console.log(`seam:      ${seamResult.dir}`)

const adapter = new ComputerEnvironmentAdapter({
  ...seamResult?.engine === undefined
    ? { dispatcher: { call: request => Promise.resolve({ ok: false, text: '', error: `no host tool transport in this script (${request.name})` }) } }
    : { seam: seamResult.engine },
  config: { app, maxCandidates: 8 },
})

/** A deterministic local rule: prefer candidates matching the objective's words. */
const provider = {
  id: 'manual-rule',
  capabilities: ['choice', 'ranking', 'score', 'classification'],
  decide: (request) => {
    const words = String(request.objective ?? '').toLowerCase().split(/\W+/).filter(word => word.length > 3)
    const scored = request.candidates
      .map((candidate, index) => {
        const description = candidate.description.toLowerCase()
        const hits = words.filter(word => description.includes(word)).length
        return { id: candidate.id, score: hits * 10 - index }
      })
      .sort((left, right) => right.score - left.score)
    return Promise.resolve({
      provider: 'manual-rule',
      mode: request.mode ?? 'choice',
      ...scored[0] === undefined ? {} : { selected: scored[0].id },
      ranking: scored,
      confidence: 0.5,
      latencyMs: 0,
    })
  },
}

const environments = new EnvironmentRegistry()
environments.register(adapter)
const engine = new DecisionEngine({ defaultProviderId: 'manual-rule' })
engine.registry.register(provider, { enabled: true, config: {} })
const runtime = new DecisionRuntime(engine, { environments })

console.log('')
const observation = await adapter.observe()
console.log(`observe:   ${observation.status}${observation.summary === undefined ? '' : ` — ${observation.summary}`}`)
if (observation.reason !== undefined) console.log(`reason:    ${observation.reason}`)
if (observation.status !== 'ok') {
  console.log('')
  console.log('The computer environment cannot express this task as structured state, so the')
  console.log('decision layer stops here rather than guessing. That is the designed behavior.')
  await adapter.dispose?.()
  process.exitCode = 1
  process.exit()
}

const outcome = await runtime.run({
  environment: 'computer',
  objective: { description: objective },
  mode: shouldExecute ? 'single-step' : 'decision-only',
  allowRisky: shouldExecute,
})

console.log('')
console.log(`decision:  ${outcome.decision?.selected ?? '(none)'}`)
console.log(`action:    ${outcome.action?.kind ?? '(none)'} target=${String(outcome.action?.target ?? '-')}`)
console.log(`describe:  ${outcome.action?.description ?? '(none)'}`)
if (outcome.escalation !== undefined) {
  console.log(`escalated: ${outcome.escalation.reason} — ${outcome.escalation.guidance}`)
}
if (!shouldExecute) {
  console.log('')
  console.log('Preview only. Re-run with --yes to execute exactly this one action.')
} else {
  console.log(`executed:  ${outcome.execution?.ok === true ? 'yes' : 'no'} — ${outcome.execution?.message ?? ''}`)
}

await adapter.dispose?.()
void ToolRuntime
