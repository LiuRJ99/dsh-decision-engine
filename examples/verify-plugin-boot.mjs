/**
 * Plugin boot verification against a real Cordis context.
 *
 * This is the strongest check available without restarting DSH: it constructs
 * the same `Context` + `ToolRuntime` the host constructs, calls the plugin's
 * `apply()`, and asserts what the host would then see — `ctx.decisionEngine`,
 * the registered `decision_decide` tool, and the environment adapters.
 *
 * It needs the installed host packages, which resolve from an installed DSH
 * profile. Run it from a directory whose module resolution reaches the profile
 * (the profile root, or with NODE_PATH set), because the local development
 * `node_modules` intentionally pins an older `@deepseek-ai/dsh-tools`:
 *
 *   cd "$HOME/.dsh/profiles" && node /path/to/dsh-decision-engine/examples/verify-plugin-boot.mjs
 *
 * Exit code 0 means the plugin boots; 2 means the host packages are not
 * resolvable from here (not a plugin failure).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

/**
 * Find one `node_modules` root that holds every host package this check needs.
 *
 * Node caches a module per real path, so the tool runtime and the context must
 * come from ONE installation: mixing the profile mirror with the CLI's bundled
 * copy yields two `dsh-tools` modules and a context the runtime rejects. This
 * enumerates candidate roots nearest-first and requires the whole set.
 */
function hostRoots() {
  const roots = []
  // 1. This checkout's own tree (what `node` resolves here anyway).
  roots.push(join(import.meta.dirname, '../node_modules'))
  // 2. An installed profile root (`~/.dsh/profiles/node_modules`).
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  for (const profile of ['', 'web', 'web-candidate', 'headless']) {
    roots.push(join(home, 'profiles', profile, 'node_modules'))
  }
  // 3. The DSH installation's own bundled copies, discovered from `which dsh`.
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

const REQUIRED = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-agent']
const hostRoot = hostRoots().find(root => REQUIRED.every((specifier) => {
  return existsSync(join(root, specifier, 'lib/index.js'))
}))
const cordisPath = hostRoot === undefined ? undefined : join(hostRoot, '@deepseek-ai/cordis/lib/index.js')
const toolsPath = hostRoot === undefined ? undefined : join(hostRoot, '@deepseek-ai/dsh-tools/lib/index.js')
if (cordisPath === undefined || toolsPath === undefined) {
  console.error('The host packages are not resolvable from here.')
  console.error('Run from an installed profile root, for example:')
  console.error('  cd "$HOME/.dsh/profiles" && node <this script>')
  process.exitCode = 2
  process.exit()
}

const pluginPath = pathToFileURL(join(import.meta.dirname, '../lib/plugin.js')).href
console.log(`cordis: ${cordisPath}`)
console.log(`tools:  ${toolsPath}`)
console.log(`plugin: ${pluginPath}`)
console.log('')

const { Context } = await import(pathToFileURL(cordisPath).href)
const { ToolRuntime } = await import(pathToFileURL(toolsPath).href)
const { apply, name, inject } = await import(pluginPath)

// A DSH agent composition mounts the prompt and skill services before the tool
// runtime; the runtime reads `ctx.systemPrompt` in its constructor, so the same
// order is required here.
const { SystemPrompt } = await import(pathToFileURL(join(hostRoot, '@deepseek-ai/dsh-system-prompt/lib/index.js')).href)
const skillModule = await import(pathToFileURL(join(hostRoot, '@deepseek-ai/dsh-skill/lib/index.js')).href).catch(() => undefined)

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const ctx = new Context()
new SystemPrompt(ctx, {})
const skillClass = skillModule === undefined
  ? undefined
  : Object.entries(skillModule).find(([exportName, value]) => typeof value === 'function' && /^Skill/.test(exportName))?.[1]
if (skillClass !== undefined) new skillClass(ctx, {})
new ToolRuntime(ctx)

check('plugin declares its name and required service', name === 'decision-engine' && Array.isArray(inject) && inject.includes('tools'), `${name} inject=${JSON.stringify(inject)}`)

// The real config shape: `defaultProvider: laya` with Laya enabled. The model
// is loaded lazily, so nothing here starts an ONNX session.
apply(ctx, {
  enabled: true,
  defaultProvider: 'laya',
  providers: { laya: { enabled: true } },
})

check('ctx.decisionEngine is published', ctx.decisionEngine !== undefined && typeof ctx.decisionEngine.decide === 'function')
check('the decision tool is registered', ctx.tools.schemas().some(schema => schema.name === 'decision_decide'), ctx.tools.schemas().map(schema => schema.name).filter(n => n.startsWith('decision_')).join(', '))
check('the task takeover tool and service are registered', ctx.tools.schemas().some(schema => schema.name === 'decision_run') && typeof ctx.decisionEngine.runTask === 'function')
check('environment adapters are registered', ctx.decisionEngine.environments.ids().includes('browser') && ctx.decisionEngine.environments.ids().includes('computer'), ctx.decisionEngine.environments.ids().join(', '))
check('the confidence floor and runtime budgets are resolved', ctx.decisionEngine.confidenceThreshold > 0 && ctx.decisionEngine.runtimeConfig.maxSteps > 0, `threshold=${ctx.decisionEngine.confidenceThreshold} maxSteps=${ctx.decisionEngine.runtimeConfig.maxSteps}`)
check('the Laya provider is registered under providers.laya, not a top-level key', ctx.decisionEngine.providers.ids().includes('laya') && ctx.decisionEngine.providers.getDefaultId() === 'laya', ctx.decisionEngine.providers.ids().join(', '))
check('no decision tool is exposed before it is needed', !ctx.tools.schemas().some(schema => /^laya_|^noul/.test(schema.name)))
check('the /decision-control skill is registered when a skill service is mounted', skillClass === undefined || ctx.get('skills') !== undefined, skillClass === undefined ? 'no skill service in this composition' : 'skill service present')

const health = await ctx.decisionEngine.health()
check(
  'health reports the provider state without loading the model',
  health.providers.laya !== undefined && ['ok', 'degraded', 'unavailable'].includes(health.providers.laya.status),
  `laya=${health.providers.laya?.status} (${health.providers.laya?.reason ?? 'no reason'})`,
)

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.label}`)
}
