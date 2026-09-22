/**
 * Architecture boundary tests — the acceptance criteria that keep this project
 * from silently collapsing into "a Laya plugin with extra steps".
 *
 * These are static checks over the source tree, so they fail the moment a
 * boundary is crossed rather than when someone notices later.
 *
 * @module dsh-decision-engine/tests/unit/architecture.test
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Every `.ts` file under `src/<dir>`, recursively. */
function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir)
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.ts')) out.push(path)
    }
  }
  walk(absolute)
  return out
}

/** Import specifiers in a file, including dynamic imports. */
function importSpecifiers(text: string): string[] {
  const specifiers: string[] = []
  const staticImport = /\bfrom\s+['"]([^'"]+)['"]/g
  const bareImport = /\bimport\s+['"]([^'"]+)['"]/g
  const dynamicImport = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of text.matchAll(staticImport)) if (match[1] !== undefined) specifiers.push(match[1])
  for (const match of text.matchAll(bareImport)) if (match[1] !== undefined) specifiers.push(match[1])
  for (const match of text.matchAll(dynamicImport)) if (match[1] !== undefined) specifiers.push(match[1])
  return specifiers
}

/** Files that must stay free of any provider and any environment. */
const CORE_DIRS = ['src/core', 'src/runtime', 'src/environments', 'src/tools']

describe('provider boundary', () => {
  it('no core, runtime, environment, or tool file imports a provider', () => {
    const violations: string[] = []
    for (const dir of CORE_DIRS) {
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, 'utf8')
        for (const specifier of importSpecifiers(text)) {
          if (/providers\//.test(specifier)) violations.push(`${file.replace(ROOT, '')} → ${specifier}`)
        }
      }
    }
    assert.deepEqual(violations, [], 'the decision core must not reach into a provider')
  })

  it('no source file outside providers/laya mentions the Laya SDK or ONNX', () => {
    const violations: string[] = []
    for (const file of sourceFiles('src')) {
      const relative = file.replace(ROOT, '')
      if (relative.startsWith('src/providers/laya/')) continue
      const text = readFileSync(file, 'utf8')
      if (/@receptron\/laya|onnxruntime/.test(text)) violations.push(relative)
    }
    assert.deepEqual(violations, [])
  })

  it('keeps noul, rl_agent, and the Laya question vocabulary inside providers/laya', () => {
    const violations: string[] = []
    for (const file of sourceFiles('src')) {
      const relative = file.replace(ROOT, '')
      if (relative.startsWith('src/providers/laya/')) continue
      // Strip comments: prose may *discuss* noul (the docs explain the mapping),
      // code may not use it.
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line))
        .join('\n')
      if (/\bnoul\b|rl_agent/.test(code)) violations.push(relative)
    }
    assert.deepEqual(violations, [])
  })

  it('has no Laya import in the browser, computer, or custom environment adapters', () => {
    for (const adapter of [
      'src/environments/browser/adapter.ts',
      'src/environments/computer/adapter.ts',
      'src/environments/custom/adapter.ts',
    ]) {
      const text = readFileSync(join(ROOT, adapter), 'utf8')
      assert.ok(!/laya/i.test(text.replace(/^\s*(\*|\/\*|\/\/).*$/gm, '')), `${adapter} mentions Laya`)
    }
  })
})

describe('environment boundary', () => {
  it('no environment file imports a provider or the Laya SDK', () => {
    const violations: string[] = []
    for (const file of sourceFiles('src/environments')) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (/providers\/|@receptron\/laya/.test(specifier)) violations.push(`${file.replace(ROOT, '')} → ${specifier}`)
      }
    }
    assert.deepEqual(violations, [])
  })

  it('no environment adapter imports another environment adapter', () => {
    const violations: string[] = []
    const families = ['browser', 'computer', 'custom']
    for (const family of families) {
      for (const file of sourceFiles(`src/environments/${family}`)) {
        for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
          for (const other of families) {
            if (other === family) continue
            if (specifier.includes(`environments/${other}/`)) violations.push(`${file.replace(ROOT, '')} → ${specifier}`)
          }
        }
      }
    }
    assert.deepEqual(violations, [])
  })

  it('never reads a screenshot: no environment file mentions screenshot analysis', () => {
    for (const file of sourceFiles('src/environments')) {
      const code = readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line)).join('\n')
      assert.ok(!/screenshot\s*\.\s*(data|width|height)|ocr|tesseract|vision/i.test(code), `${file.replace(ROOT, '')} touches pixels`)
    }
  })
})

describe('host dependency boundary', () => {
  it('imports only the public host packages, never a plugin internal path', () => {
    const allowed = new Set([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/schemastery',
      '@receptron/laya',
    ])
    const violations: string[] = []
    for (const file of sourceFiles('src')) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
        if (allowed.has(specifier)) continue
        violations.push(`${file.replace(ROOT, '')} → ${specifier}`)
      }
    }
    assert.deepEqual(violations, [], 'only public host seams and the optional model SDK may be imported')
  })

  it('never imports a browser or computer plugin internal file', () => {
    const violations: string[] = []
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8')
      if (/dsh-browser|dsh-computer-use|bridge-browser|codex-computer-use/.test(text)) violations.push(file.replace(ROOT, ''))
    }
    assert.deepEqual(violations, [])
  })

  it('never references a concrete tool name outside the environment adapters', () => {
    const violations: string[] = []
    for (const dir of ['src/core', 'src/runtime', 'src/providers']) {
      for (const file of sourceFiles(dir)) {
        const code = readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line)).join('\n')
        if (/browser_click|computer_use_click|browser_snapshot|computer_use_/.test(code)) violations.push(file.replace(ROOT, ''))
      }
    }
    assert.deepEqual(violations, [], 'a decision provider must not know a tool name')
  })

  it('keeps the capability gate out of the decision layer', () => {
    // The plugin may *query* the gate; it must never implement one. A local
    // gate would be a second source of truth for permission.
    const plugin = readFileSync(join(ROOT, 'src/plugin.ts'), 'utf8')
    assert.ok(/TOOL_LAZY_GATE_SERVICE/.test(plugin), 'the plugin is expected to query the existing gate')
    assert.match(readFileSync(join(ROOT, 'src/gate.ts'), 'utf8'), /TOOL_LAZY_GATE_SERVICE = 'toolLazyGate'/)
    const gate = readFileSync(join(ROOT, 'src/gate.ts'), 'utf8')
    assert.ok(!/ctx\.tools\.(guard|restrict)\(/.test(gate), 'the decision layer must not install its own guard')
    assert.ok(!/grant\(/.test(gate), 'the decision layer must never grant a capability')
  })
})

describe('public surface', () => {
  it('exposes exactly one decision tool', () => {
    const index = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
    const names = [...index.matchAll(/name:\s*'(decision_[a-z_]+)'/g)].map(match => match[1])
    const fromTool = [...readFileSync(join(ROOT, 'src/tools/decision-decide.ts'), 'utf8').matchAll(/name:\s*'(decision_[a-z_]+)'/g)].map(match => match[1])
    const all = new Set([...names, ...fromTool])
    assert.deepEqual([...all], ['decision_decide'])
  })

  it('uses model-neutral names: no laya_* tool and no /laya skill', () => {
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8')
      assert.ok(!/laya_choose|laya_score|laya_noul/.test(text), `${file.replace(ROOT, '')} exposes a Laya-named tool`)
    }
    const skill = readFileSync(join(ROOT, 'src/skill.ts'), 'utf8')
    assert.match(skill, /DECISION_CONTROL_SKILL_NAME = 'decision-control'/)
  })

  it('keeps the protocol free of provider-private fields', () => {
    const types = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8')
    assert.match(types, /providerMetadata|debug/)
    assert.ok(!/raw\s*:\s*unknown[\s\S]{0,200}selected/.test(types))
  })
})

describe('cycle safety', () => {
  it('the environments barrel does not import the core barrel', () => {
    const text = readFileSync(join(ROOT, 'src/environments/types.ts'), 'utf8')
    for (const specifier of importSpecifiers(text)) {
      assert.ok(specifier !== '../core/index.ts', 'import concrete core modules, not the barrel, to avoid cycles')
    }
  })
})
