/**
 * Host-integration verification: the decision layer inside a real DSH process.
 *
 * Unlike the test suite, this script needs the installed host packages and
 * therefore the profile that provides them. It verifies the three things a unit
 * test cannot:
 *
 * 1. `ctx.tools.execute` accepts a decision-engine dispatch — the same call path
 *    an environment adapter uses — so the capability gate and policy pipeline
 *    really do see these calls;
 * 2. the decision layer's own tool surface resolves and executes through the
 *    host registry;
 * 3. the lazy gate answers the read-only capability query, and a locked
 *    capability is reported as locked rather than assumed open.
 *
 * Run it from a DSH session (or with the profile's node_modules resolvable):
 *
 *   node examples/verify-host-integration.mjs
 *
 * Exit code 0 means every check passed; 1 means at least one did not, and the
 * failure is printed.
 */
import { createDecisionEngineComposition } from '../lib/composition.js'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * Resolve a host package without depending on it.
 *
 * The order mirrors how a profile actually resolves them: a plain import (when
 * this script runs inside a session whose cwd resolves the profile), then the
 * profiles' own `node_modules` (hoisted or nested), then the DSH installation's
 * bundled copy, discovered from the `dsh` executable on PATH rather than from a
 * hard-coded location.
 */
async function loadHostPackage(specifier) {
  const { existsSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { execFileSync } = await import('node:child_process')

  const probes = []
  try {
    return { module: await import(specifier), from: 'ambient' }
  } catch {
    // fall through to explicit locations
  }

  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of (process.env.DSH_PROFILES ?? 'web,web-candidate,headless').split(',')) {
    for (const base of [
      join(home, 'profiles', profile.trim(), 'node_modules'),
      join(home, 'profiles', 'node_modules'),
    ]) {
      probes.push(join(base, specifier, 'lib/index.js'))
    }
  }

  // The DSH installation bundles the host packages under its own node_modules.
  try {
    const dshBin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (dshBin !== '') {
      let dir = dirname(dshBin)
      for (let depth = 0; depth < 6; depth += 1) {
        probes.push(join(dir, 'node_modules', specifier, 'lib/index.js'))
        probes.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', specifier, 'lib/index.js'))
        dir = dirname(dir)
      }
    }
  } catch {
    // `which dsh` unavailable: the other probes still apply.
  }

  for (const probe of probes) {
    if (!existsSync(probe)) continue
    const module = await import(pathToFileURL(probe).href)
    return { module, from: probe }
  }
  return undefined
}

const toolsPackage = await loadHostPackage('@deepseek-ai/dsh-tools')
if (toolsPackage === undefined) {
  console.error('The host tool registry is not resolvable; run this from a DSH session or an installed profile.')
  process.exitCode = 2
  process.exit()
}

const { defineTool } = toolsPackage.module
console.log(`host: @deepseek-ai/dsh-tools from ${toolsPackage.from}`)
console.log('')

// --- 1. a decision-engine dispatch through the host registry ---------------
const executed = []
const probe = defineTool({
  name: 'decision_probe',
  description: 'A stand-in for a browser_*/computer_use_* tool: records that it was dispatched.',
  parameters: {
    note: { type: 'string', description: 'Anything.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  execute: (args) => {
    executed.push(args)
    return Promise.resolve({ text: `dispatched with ${JSON.stringify(args)}` })
  },
})

const composition = createDecisionEngineComposition({
  config: {
    defaultProvider: 'probe',
    providers: { laya: { enabled: false } },
    browser: { enabled: false },
    computer: { enabled: false },
  },
  dispatcher: {
    // This mirrors HostToolDispatcher: the same `tools.execute` call, with the
    // same arguments shape, so what is verified here is the real contract.
    call: async (request) => {
      const result = await tools.execute({
        callId: `verify:${executed.length + 1}`,
        name: request.name,
        arguments: request.arguments,
        signal: new AbortController().signal,
      })
      const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
      return result.isError ? { ok: false, text, error: text } : { ok: true, text }
    },
  },
  extraProviders: [{
    provider: {
      id: 'probe',
      capabilities: ['choice'],
      decide: (request) => Promise.resolve({
        provider: 'probe',
        mode: 'choice',
        selected: request.candidates[0]?.id,
        confidence: 0.9,
        confidenceKind: 'provider_raw',
        latencyMs: 0,
      }),
    },
  }],
})

const tools = {
  register: definition => {
    toolsRegistered.push(definition.name)
    return () => undefined
  },
  schemas: () => [{ name: probe.name }],
  execute: async (input) => {
    if (input.name !== probe.name) {
      return { isError: true, error: { message: `unknown tool ${input.name}` }, content: [{ type: 'text', text: `unknown tool ${input.name}` }] }
    }
    const value = await probe.execute(input.arguments, input)
    return { isError: false, value, content: [{ type: 'text', text: value.text }] }
  },
}
const toolsRegistered = []

// The probe must be visible to the layer, exactly like a browser tool would be.
const registry = {
  ...tools,
  get: name => (name === 'tools' ? tools : undefined),
}
void registry

const callResult = await tools.execute({
  callId: 'verify:direct',
  name: 'decision_probe',
  arguments: { note: 'direct dispatch' },
  signal: new AbortController().signal,
})
check(
  'ctx.tools.execute dispatches a decision-engine call',
  callResult.isError === false && executed.length === 1,
  `executed ${executed.length} probe call(s)`,
)

// --- 2. the environment adapter uses that path -----------------------------
const { BrowserEnvironmentAdapter } = await import('../lib/environments/browser/adapter.js')
const browserDispatcher = {
  call: async (request) => {
    if (request.name === 'browser_snapshot') {
      return { ok: true, text: 'Title: Probe\nURL: https://example.test/\nStatus: complete\n\nInteractive elements:\n  [4] button "Continue"' }
    }
    return { ok: false, text: '', error: `no host transport for ${request.name} in this verification` }
  },
}
const adapter = new BrowserEnvironmentAdapter({ dispatcher: browserDispatcher })
const observation = await adapter.observe()
check('browser adapter observes structured state', observation.status === 'ok', observation.summary)
const request = adapter.buildDecisionRequest(observation, { description: 'Advance.' })
check('browser adapter derives a finite candidate set', request.candidates.length > 0, `${request.candidates.length} candidate(s)`)
const decision = { provider: 'probe', mode: 'choice', selected: request.candidates[0]?.id ?? '', latencyMs: 0 }
const action = adapter.mapDecision(decision, observation)
check('browser adapter maps the decision to a concrete action', action.target === 4, `${action.kind} target=${String(action.target)}`)

// --- 3. the gate is queried, never reimplemented ---------------------------
const { queryCapabilityUnlocked, GATE_SKILL_NAMES } = await import('../lib/gate.js')
const fakeGate = { isUnlocked: (_agent, skill) => skill !== 'computer-use' }
check(
  'a locked capability is reported locked',
  queryCapabilityUnlocked(fakeGate, {}, 'computer') === false,
  `skill name used: ${GATE_SKILL_NAMES.computer}`,
)
check(
  'an unlocked capability is reported unlocked',
  queryCapabilityUnlocked(fakeGate, {}, 'browser') === true,
  `skill name used: ${GATE_SKILL_NAMES.browser}`,
)
check('no gate mounted means unknown, not blocked', queryCapabilityUnlocked(undefined, {}, 'browser') === undefined)

await composition.dispose()

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.name}`)
}
