/**
 * Single-package build for dsh-decision-engine.
 *
 * Two artifact families, mirroring the shape every DSH plugin in this workspace
 * uses:
 *
 * - Host entries (`index` plus one per area) are plain Node ESM with every
 *   `@deepseek-ai/*` package left external — the harness profile provides them
 *   at runtime.
 * - `lib/types/**` declarations are emitted by `tsc` (esbuild strips types).
 *
 * `@receptron/laya` is deliberately NOT a dependency of this package: it is an
 * optional peer resolved from the profile. The provider imports it dynamically,
 * so a machine without the model runtime still loads the plugin and reports the
 * provider as degraded instead of failing to start.
 *
 * The build runs on demand (`npm run build`) and before publishing; it is never
 * an install script, because git-hosted installs rely on committed artifacts.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

mkdirSync('lib', { recursive: true })

/** Packages the harness (or the installed profile) provides at runtime. */
const HOST_EXTERNAL = ['@deepseek-ai/*']

const ENTRIES = [
  { entry: 'src/index.ts', outfile: 'lib/index.js' },
  { entry: 'src/plugin.ts', outfile: 'lib/plugin.js' },
  { entry: 'src/composition.ts', outfile: 'lib/composition.js' },
  { entry: 'src/embed.ts', outfile: 'lib/embed.js' },
  { entry: 'src/core/index.ts', outfile: 'lib/core/index.js' },
  { entry: 'src/runtime/index.ts', outfile: 'lib/runtime/index.js' },
  { entry: 'src/environments/browser/adapter.ts', outfile: 'lib/environments/browser/adapter.js' },
  { entry: 'src/environments/browser/snapshot.ts', outfile: 'lib/environments/browser/snapshot.js' },
  { entry: 'src/environments/computer/adapter.ts', outfile: 'lib/environments/computer/adapter.js' },
  { entry: 'src/environments/computer/ax-tree.ts', outfile: 'lib/environments/computer/ax-tree.js' },
  { entry: 'src/environments/custom/adapter.ts', outfile: 'lib/environments/custom/adapter.js' },
  { entry: 'src/environments/http/adapter.ts', outfile: 'lib/environments/http/adapter.js' },
  { entry: 'src/environments/registry.ts', outfile: 'lib/environments/registry.js' },
  { entry: 'src/providers/laya/index.ts', outfile: 'lib/providers/laya/index.js' },
  { entry: 'src/gate.ts', outfile: 'lib/gate.js' },
  { entry: 'src/skill.ts', outfile: 'lib/skill.js' },
]

for (const { entry, outfile } of ENTRIES) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    external: HOST_EXTERNAL,
    logLevel: 'warning',
  })
}

execFileSync(
  process.execPath,
  [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
)

console.log(`built ${ENTRIES.length} entries + declarations`)
