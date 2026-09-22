/**
 * End-to-end tool verification: execute both public decision tools through
 * a real host tool registry, with a registered environment, and assert that the
 * whole path a model call takes works.
 *
 * ```text
 * ctx.tools.execute({ name: 'decision_decide', … })
 *   → tools/pre-execute policy + guards
 *   → the tool body
 *   → engine → provider → environment adapter → execute
 *   → canonical value + rendered text
 * ```
 *
 * The provider is replaced with a deterministic stub so this check measures the
 * plumbing, not ONNX. Everything else is the production composition.
 *
 * Usage:
 *   node examples/verify-tool-execution.mjs
 *
 * Exit code 0 means every check passed; 1 means at least one did not; 2 means
 * the host packages are not resolvable from here.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

function hostRoots() {
  const roots = [join(import.meta.dirname, '../node_modules')]
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of ['', 'web', 'web-candidate', 'headless']) {
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

const REQUIRED = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-agent']
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
const { apply } = await import('../lib/plugin.js')
const { CustomEnvironmentAdapter } = await import('../lib/environments/custom/adapter.js')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const ctx = new Context()
new SystemPrompt(ctx, {})
new ToolRuntime(ctx)
apply(ctx, { enabled: true, defaultProvider: 'laya', providers: { laya: { enabled: true } } })

// Replace the ONNX-backed decide with a deterministic stub. This is the only
// substitution: composition, tool, engine, runtime, adapter, and registry are
// the production ones.
const providerCalls = []
const entry = ctx.decisionEngine.providers.entry('laya')
entry.provider.decide = async (request) => {
  providerCalls.push(request)
  const pick = request.candidates[0]
  return {
    provider: 'laya',
    mode: request.mode ?? 'choice',
    ...pick === undefined ? {} : { selected: pick.id },
    ranking: request.candidates.map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.1 })),
    confidence: 0.8,
    confidenceKind: 'provider_raw',
    latencyMs: 0,
  }
}

let moves = 0
ctx.decisionEngine.environments.register(new CustomEnvironmentAdapter({
  id: 'demo-game',
  observe: () => ({ moves, availableActions: ['go', 'stop'] }),
  candidates: state => state.availableActions.map(action => ({ id: action, description: `Action ${action}` })),
  execute: () => {
    moves += 1
    return { ok: true, message: `move ${moves}` }
  },
}))

async function callTool(arguments_, name = 'decision_decide') {
  return ctx.tools.execute({
    callId: `verify:${providerCalls.length}:${moves}`,
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
  })
}

const textOf = result => result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')

// --- decision only ---------------------------------------------------------
const preview = await callTool({
  objective: 'Choose the next step',
  state: { ready: true },
  candidates: [
    { id: 'open', description: 'Open the file' },
    { id: 'wait', description: 'Keep waiting' },
  ],
})
check('decision_decide answers a plain decision', preview.isError === false && preview.value?.status === 'decided', JSON.stringify(preview.value ?? preview.error))
check('the tool output renders as text the model can read', /Decision: open/.test(textOf(preview)), textOf(preview).split('\n')[0])

// --- environment, decision only -------------------------------------------
const environmentPreview = await callTool({ environment: 'demo-game', objective: 'Advance.' })
check('decision-only against an environment executes nothing', environmentPreview.value?.status === 'decided' && moves === 0, `status=${environmentPreview.value?.status} moves=${moves}`)
check('the mapped action is previewed with its environment vocabulary', environmentPreview.value?.action?.kind === 'custom' && environmentPreview.value?.action?.candidateId === 'go', JSON.stringify(environmentPreview.value?.action))

// --- environment, single step ---------------------------------------------
const single = await callTool({ environment: 'demo-game', objective: 'Advance.', execute: true })
check('execute: true runs exactly one mapped action', single.value?.status === 'executed' && moves === 1, `status=${single.value?.status} moves=${moves}`)
check('the execution result reaches the tool output', single.value?.executionMessage === 'move 1', String(single.value?.executionMessage))

// --- environment, bounded loop --------------------------------------------
const loop = await callTool({ environment: 'demo-game', objective: 'Advance.', execute: 'loop', maxSteps: 3 })
check('execute: "loop" runs the bounded loop and stops at maxSteps', loop.value?.status === 'needs_escalation' && moves === 4, `status=${loop.value?.status} moves=${moves} reason=${loop.value?.guidance ?? ''}`)
check('a budget stop carries guidance for the main agent', /re-plan|budget/i.test(String(loop.value?.guidance ?? '')), String(loop.value?.guidance ?? ''))

// A complete plan passes through the real host schema, executor and renderer.
const task = await callTool({
  environment: 'demo-game', objective: 'Finish the supplied plan.',
  plan: [
    { id: 'prepare', objective: 'Advance to move six.', completion: { path: 'moves', equals: 6 } },
    { id: 'finish', objective: 'Advance to move seven.', completion: { path: 'moves', equals: 7 } },
  ],
}, 'decision_run')
check('decision_run executes a whole plan through the host registry', task.isError === false && task.value?.status === 'done' && moves === 7, JSON.stringify(task.value ?? task.error))
check('the task report includes completed stages and final observed state', task.value?.completedPlanSteps?.join(',') === 'prepare,finish' && task.value?.finalState?.moves === 7)

// --- refusals --------------------------------------------------------------
const badCandidates = await callTool({ objective: 'x', state: { a: 1 }, candidates: [] })
check('an empty candidate set is refused before dispatch', badCandidates.isError === true, JSON.stringify(badCandidates.error).slice(0, 120))
const unknownEnvironment = await callTool({ environment: 'nope', objective: 'x' })
check('an unknown environment is refused with the registered ids named', unknownEnvironment.isError === true && /demo-game/.test(textOf(unknownEnvironment)), textOf(unknownEnvironment).slice(0, 120))

// --- provider isolation ----------------------------------------------------
const serialized = JSON.stringify(providerCalls)
check('the provider never learns a tool name', !/browser_|computer_use_|demo-game\./.test(serialized), `${providerCalls.length} provider call(s) inspected`)

await ctx.decisionEngine.dispose()

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.label}`)
}
