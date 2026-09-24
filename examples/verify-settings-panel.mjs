/**
 * Host settings verification: register the plugin namespace against the real
 * file-backed settings provider. The Web card is verified separately.
 *
 * It exercises the Host half of the settings flow:
 *
 * 1. `ctx.settings.describe()` lists the namespace with a serialized schema;
 * 2. that schema carries field descriptions for other settings consumers;
 * 3. a write through `ctx.settings.update()` reaches the plugin's live engine,
 *    and the value the panel reads back is the one that took effect.
 *
 * It uses a scratch settings file, so it never touches the user's document.
 *
 * Usage:
 *   node examples/verify-settings-panel.mjs
 *
 * Exit code 0 means every check passed; 1 otherwise; 2 when the host packages
 * are not resolvable from here.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

/** Host packages the settings provider needs, resolved from one installation. */
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
    // No `which dsh`; the earlier roots still apply.
  }
  return roots
}

const REQUIRED = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-settings-file',
]
const hostRoot = hostRoots().find(root => REQUIRED.every(specifier => existsSync(join(root, specifier, 'lib/index.js'))))
if (hostRoot === undefined) {
  console.error('The host packages (including dsh-settings-file) are not resolvable from here.')
  process.exitCode = 2
  process.exit()
}

const load = specifier => import(pathToFileURL(join(hostRoot, specifier, 'lib/index.js')).href)
const { Context } = await load('@deepseek-ai/cordis')
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { FileSettingsProvider } = await load('@deepseek-ai/dsh-settings-file')
const { apply, SETTINGS_NAMESPACE } = await import('../lib/plugin.js')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// A scratch settings document: the plugin must never write to the user's.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-des-settings-'))
const settingsPath = join(scratch, 'settings.yaml')

const ctx = new Context()
const routes = new Map()
ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
new SystemPrompt(ctx, {})
new ToolRuntime(ctx)
await ctx.plugin(FileSettingsProvider, { path: settingsPath, dshHome: scratch, watch: false, debounceMs: 0 })

console.log(`host:     ${hostRoot}`)
console.log(`settings: ${settingsPath}`)
console.log('')

// The bundle row's config, as the profile composes it.
apply(ctx, {
  enabled: true,
  defaultProvider: 'laya',
  providers: { laya: { enabled: true, device: 'cpu', modelDir: process.env.HOME + '/.cache/receptron-laya/receptron--laya-onnx/main' } },
  runtime: { confidenceThreshold: 0.55, maxSteps: 10 },
  browser: { enabled: true },
  computer: { enabled: true },
})

// Let the provider finish its initial document load before inspection.
await new Promise(resolve => setTimeout(resolve, 0))

// --- 1. the namespace is discoverable -------------------------------------
const listed = await ctx.settings.describe()
const namespaces = Array.isArray(listed) ? listed : listed.namespaces ?? []
const ours = namespaces.find(entry => entry.ns === SETTINGS_NAMESPACE)
check('Host settings exposes the namespace', ours !== undefined, namespaces.map(entry => entry.ns).join(', '))

if (ours === undefined) {
  rmSync(scratch, { recursive: true, force: true })
  console.log('')
  console.log(`${results.filter(r => r.ok).length}/${results.length} checks passed`)
  process.exitCode = 1
  process.exit()
}

// --- 2. the schema renders fields with help text --------------------------
const schemaText = JSON.stringify(ours.schema)
const descriptionCount = (schemaText.match(/"description"/g) ?? []).length
check('the schema carries field descriptions for the panel', descriptionCount >= 20, `${descriptionCount} descriptions`)
for (const field of ['defaultProvider', 'confidenceThreshold', 'maxSteps', 'autoLoad', 'idleTtlMs', 'captureTimeoutMs']) {
  check(`"${field}" is present in the rendered schema`, schemaText.includes(field))
}
check('the settings descriptor marks live fields', ours.applies === 'live', String(ours.applies))

// --- 3. values reflect the composition base -------------------------------
const value = ours.value
check('the resolved value shows the composition config', value?.defaultProvider === 'laya' && value?.runtime?.confidenceThreshold === 0.55,
  `defaultProvider=${value?.defaultProvider} threshold=${value?.runtime?.confidenceThreshold}`)
const initialHealth = await ctx.decisionEngine.health()
check('Laya loads on use and releases after ten idle minutes by default',
  value?.providers?.laya?.autoLoad === false
    && value?.providers?.laya?.idleTtlMs === 600_000
    && initialHealth.providers.laya?.details?.idleTtlMs === 600_000)
check('nothing is marked as a user override yet', ours.user === undefined || Object.keys(ours.user ?? {}).length === 0)

function catalogIds() {
  const route = routes.get('/plugins/dsh-decision-engine/providers')
  if (route === undefined) return []
  let body = ''
  const res = { setHeader() {}, end(value) { body = value }, statusCode: 200 }
  route.handler({ method: 'GET', headers: { host: 'localhost' } }, res)
  return JSON.parse(body).providers
}
check('the Web model selector reads the live provider catalog', JSON.stringify(catalogIds()) === '["laya"]')

// --- 4. a write reaches the live engine -----------------------------------
const before = ctx.decisionEngine.confidenceThreshold
await ctx.settings.update(SETTINGS_NAMESPACE, { runtime: { confidenceThreshold: 0.2, maxSteps: 4 } })
const after = ctx.decisionEngine.confidenceThreshold
check('a settings write reaches the live engine', before === 0.55 && after === 0.2, `${before} → ${after}`)
check('a settings write reaches the live runtime budgets', ctx.decisionEngine.runtimeConfig.maxSteps === 4, String(ctx.decisionEngine.runtimeConfig.maxSteps))
check('the write is persisted to the settings document', existsSync(settingsPath) && readFileSync(settingsPath, 'utf8').includes('0.2'))

const reread = (await ctx.settings.describe())
const rereadList = Array.isArray(reread) ? reread : reread.namespaces ?? []
const rereadOurs = rereadList.find(entry => entry.ns === SETTINGS_NAMESPACE)
check('the panel reads the written value back', rereadOurs?.value?.runtime?.confidenceThreshold === 0.2, String(rereadOurs?.value?.runtime?.confidenceThreshold))
check('the changed field is marked as a user override', JSON.stringify(rereadOurs?.user ?? {}).includes('confidenceThreshold'))

// A second registered model is selectable through the same settings write.
const removeAlternative = ctx.decisionEngine.providers.register({
  id: 'alternative',
  capabilities: ['choice'],
  decide: async () => ({ provider: 'alternative', mode: 'choice', selected: 'a', latencyMs: 0 }),
})
check('the model catalog includes a newly registered provider', JSON.stringify(catalogIds()) === '["laya","alternative"]')
await ctx.settings.update(SETTINGS_NAMESPACE, { defaultProvider: 'alternative' })
const switched = await ctx.decisionEngine.decide({ state: 'ready', candidates: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }] })
check('a saved default switches live routing to another registered model',
  switched.provider === 'alternative' && (await ctx.decisionEngine.health()).defaultProvider === 'alternative')
await ctx.settings.update(SETTINGS_NAMESPACE, { defaultProvider: 'laya' })
removeAlternative()

// --- 5. a bad value is refused, not stored --------------------------------
let refused = false
try {
  await ctx.settings.update(SETTINGS_NAMESPACE, { runtime: { maxSteps: 'many' } })
} catch {
  refused = true
}
check('an invalid value is refused by the schema', refused)

// --- 6. restart-required fields shape the next composition ---------------
await ctx.settings.update(SETTINGS_NAMESPACE, {
  providers: { laya: { enabled: false } },
  browser: { enabled: false },
})
check('provider and environment changes leave the running instance intact',
  ctx.decisionEngine.providers.has('laya') && ctx.decisionEngine.environments.ids().includes('browser'))
check('restart-required overrides reached the settings file',
  readFileSync(settingsPath, 'utf8').includes('enabled: false'))

const restarted = new Context()
new SystemPrompt(restarted, {})
new ToolRuntime(restarted)
await restarted.plugin(FileSettingsProvider, { path: settingsPath, dshHome: scratch, watch: false, debounceMs: 0 })
apply(restarted, {
  enabled: true,
  defaultProvider: 'laya',
  providers: { laya: { enabled: true, device: 'cpu' } },
  browser: { enabled: true },
  computer: { enabled: true },
})
const nextDescribe = await restarted.settings.describe()
const nextEntry = (Array.isArray(nextDescribe) ? nextDescribe : nextDescribe.namespaces ?? []).find(entry => entry.ns === SETTINGS_NAMESPACE)
check('saved provider and environment switches apply on the next construction',
  !restarted.decisionEngine.providers.has('laya') && !restarted.decisionEngine.environments.ids().includes('browser'),
  `providers=${restarted.decisionEngine.providers.ids()} environments=${restarted.decisionEngine.environments.ids()} user=${JSON.stringify(nextEntry?.user)}`)

rmSync(scratch, { recursive: true, force: true })

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.label}`)
}
