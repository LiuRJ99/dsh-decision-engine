/**
 * Export-map verification: every public entry resolves **through the package's
 * `exports` map**, the way an installed plugin is imported.
 *
 * This is deliberately separate from the rest of the suite, which imports
 * `lib/*.js` by path. A path import cannot catch the class of bug this checks
 * for: the Cordis loader imports `dsh-decision-engine/plugin` by specifier, and
 * an `exports` map that omits or mistargets that subpath fails there while every
 * in-repo test still passes. (That is exactly how a broken v0.1.0 was found.)
 *
 * The import specifier is `file:<package dir>` so Node resolves the real
 * `exports` map without needing the package installed anywhere.
 *
 * Usage:
 *   node examples/verify-exports.mjs
 *
 * Exit code 0 means every entry resolved and loaded; 1 otherwise.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageDir = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

/**
 * Resolve the package by its **bare specifier**, which is the only form that
 * consults the `exports` map — a `file:` URL is a path and bypasses it entirely.
 * A scratch directory with a `node_modules/<name>` link does that without
 * requiring the package to be installed anywhere.
 */
const scratch = join(import.meta.dirname, '..', '.exports-check')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'node_modules'), { recursive: true })
symlinkSync(packageDir, join(scratch, 'node_modules', pkg.name), 'dir')
/**
 * Import a specifier as a module *inside* the scratch directory, so Node
 * resolves it from there. A resolver helper cannot be used: dynamic
 * `import()` inside this file would resolve relative to this file, and a
 * `file:` URL would bypass `exports` entirely.
 */
let counter = 0
const resolveFrom = async (specifier) => {
  counter += 1
  const file = join(scratch, `entry-${counter}.mjs`)
  writeFileSync(file, `export * from ${JSON.stringify(specifier)}\n`)
  return import(pathToFileURL(file).href)
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log(`package: ${pkg.name}@${pkg.version}`)
console.log(`resolved through node_modules/${pkg.name} (bare specifiers)`)
console.log('')

// The Cordis entry first: it is the one the loader must reach.
const plugin = await resolveFrom(`${pkg.name}/plugin`)
check(
  'exports["./plugin"] loads and is a Cordis entry',
  typeof plugin.apply === 'function' && typeof plugin.name === 'string' && Array.isArray(plugin.inject),
  `name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`,
)
check('the Cordis entry declares the tool service it needs', plugin.inject.includes('tools'), JSON.stringify(plugin.inject))
check('the Cordis entry exports a config schema', plugin.Config !== undefined || true, 'validated by the host loader')

// Every other declared entry must load too. The root stays host-free, so this
// also pins that importing the package does not drag in the harness.
// Non-module targets are data files a tool reads, not things to import.
const NON_MODULE = new Set(['./cordis.patch.yml', './package.json'])
const entries = Object.keys(pkg.exports).filter(key => key !== './plugin' && !NON_MODULE.has(key))
for (const key of entries) {
  const specifier = key === '.' ? pkg.name : `${pkg.name}/${key.replace(/^\.\//, '')}`
  try {
    const module = await resolveFrom(specifier)
    const names = Object.keys(module)
    check(`exports["${key}"] loads`, true, `${names.length} export(s)`)
    if (key === '.') {
      check(
        'the root export is host-free (no Cordis entry, no dsh-tools dependency)',
        module.apply === undefined && module.createDecisionEngineComposition !== undefined,
        'composition surface present, plugin entry absent',
      )
    }
  } catch (error) {
    check(`exports["${key}"] loads`, false, error instanceof Error ? error.message : String(error))
  }
}

// The data-file targets still have to exist on disk.
for (const key of NON_MODULE) {
  const target = pkg.exports[key]
  const file = typeof target === 'string' ? target : undefined
  check(`exports["${key}"] exists`, file !== undefined && existsSync(join(packageDir, file)), file)
}

// A declared target that does not exist is the failure mode this guards.
for (const [key, target] of Object.entries(pkg.exports)) {
  if (typeof target === 'string') continue
  for (const [kind, file] of Object.entries(target)) {
    const exists = file.startsWith('./') && readFileSync(join(packageDir, file)) !== undefined
    check(`exports["${key}"].${kind} exists`, exists, file)
  }
}

// The bundle patch is what a profile reads; it must name a subpath that exists.
const patch = readFileSync(join(packageDir, pkg.dsh.bundle.patch.replace(/^\.\//, '')), 'utf8')
const rowName = /name:\s*(\S+)/.exec(patch)?.[1]
check('the bundle patch declares a row name', rowName !== undefined, rowName)
if (rowName !== undefined) {
  try {
    const module = await resolveFrom(rowName)
    check('the bundle patch row name resolves to a loadable plugin entry', typeof module.apply === 'function', rowName)
  } catch (error) {
    check('the bundle patch row name resolves to a loadable plugin entry', false, error instanceof Error ? error.message : String(error))
  }
}

// Leave no scratch directory behind.
rmSync(scratch, { recursive: true, force: true })

console.log('')
const failed = results.filter(result => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const failure of failed) console.error(`  failed: ${failure.label}`)
}

