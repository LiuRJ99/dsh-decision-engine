/**
 * Settings-panel verification: register the plugin's settings namespace against
 * the **real** file-backed settings provider and inspect the descriptor the
 * built-in plugin settings panel consumes.
 *
 * This is the check that "the panel renders our config" is true rather than
 * assumed. It exercises the same three things the panel does:
 *
 * 1. `ctx.settings.describe()` lists the namespace with a serialized schema;
 * 2. that schema carries a description for every field (the panel's help text);
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
new SystemPrompt(ctx, {})
new ToolRuntime(ctx)
new FileSettingsProvider(ctx, { path: settingsPath, dshHome: scratch, watch: false, debounceMs: 0 })

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

// `ctx.inject` defers its callback to the next microtask, so the registration
// has not happened yet at the end of `apply()`. A real host has the same
// behavior; wait a tick before asking the panel what it sees.
await new Promise(resolve => setTimeout(resolve, 0))

// --- 1. the namespace is discoverable -------------------------------------
const listed = await ctx.settings.describe()
const namespaces = Array.isArray(listed) ? listed : listed.namespaces ?? []
const ours = namespaces.find(entry => entry.ns === SETTINGS_NAMESPACE)
check('the settings panel can discover the namespace', ours !== undefined, namespaces.map(entry => entry.ns).join(', '))

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
check('the panel is told changes apply live', ours.applies === 'live', String(ours.applies))

// --- 3. values reflect the composition base -------------------------------
const value = ours.value
check('the resolved value shows the composition config', value?.defaultProvider === 'laya' && value?.runtime?.confidenceThreshold === 0.55,
  `defaultProvider=${value?.defaultProvider} threshold=${value?.runtime?.confidenceThreshold}`)
check('nothing is marked as a user override yet', ours.user === undefined || Object.keys(ours.user ?? {}).length === 0)

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

// --- 5. a bad value is refused, not stored --------------------------------
let refused = false
try {
  await ctx.settings.update(SETTINGS_NAMESPACE, { runtime: { maxSteps: 'many' } })
} catch {
  refused = true
}
check('an invalid value is refused by the schema', refused)

rmSync(scratch, { recursive: true, force: true })

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.label}`)
}
