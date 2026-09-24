import { existsSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const paths = new Set([pkg.main, pkg.types, pkg.dsh?.bundle?.patch])
for (const entry of Object.values(pkg.exports ?? {})) {
  if (typeof entry === 'string') paths.add(entry)
  else for (const target of Object.values(entry)) paths.add(target)
}
const missing = [...paths].filter(path => typeof path === 'string' && !existsSync(path))
if (missing.length > 0) {
  throw new Error(`Package entry files are missing: ${missing.join(', ')}`)
}
console.log(`verified ${paths.size} package entry files`)
