import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dir, '..')

// Code that ships or runs the product. Tests, e2e specs and build output are out of scope.
const SCAN_DIRS = ['apps/web/src', 'packages', 'scripts', 'training/trainer']
const SCAN_FILES = ['apps/web/port.ts', 'apps/web/vite.config.ts', 'apps/web/playwright.config.ts', 'apps/web/drizzle.config.ts']
const SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', '.output', 'dist', 'test-results', 'fixtures', 'tests'])
const SKIP_FILE = /(\.test\.|\.spec\.|\.slow\.test\.)/
// Vite and the runtime set these themselves; they are not configuration.
const BUILT_IN = new Set(['DEV', 'PROD', 'MODE', 'SSR', 'BASE_URL'])
// Operating system variables, not configuration.
const SYSTEM = new Set(['PATH', 'HOME'])

const PATTERNS: RegExp[] = [
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
  /\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /\bimport\.meta\.env\??\.([A-Z][A-Z0-9_]*)/g,
  /\bBun\.env\.([A-Z][A-Z0-9_]*)/g,
  /\bos\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /\bos\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  // A parameter named env (the auth and db helpers take one so tests can pass their own): env.NAME
  /(?<![\w.])env\.([A-Z][A-Z0-9_]{2,})\b/g,
]

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|py)$/.test(name) && !SKIP_FILE.test(name)) out.push(p)
  }
}

/** Env var names read by the code, each with the first file that reads it. */
export function envVarsInCode(root: string = ROOT): Map<string, string> {
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(join(root, d), files)
  for (const f of SCAN_FILES) if (existsSync(join(root, f))) files.push(join(root, f))
  const found = new Map<string, string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const name = m[1]!
        if (SYSTEM.has(name) || (BUILT_IN.has(name) && re.source.includes('import'))) continue
        if (!found.has(name)) found.set(name, relative(root, file).split(sep).join('/'))
      }
    }
    // Fields of an `interface ...Env { NAME?: string }` are the slice of the environment a helper reads.
    for (const block of text.matchAll(/interface\s+\w*Env\s*\{([^}]*)\}/g)) {
      for (const f of block[1]!.matchAll(/^\s*([A-Z][A-Z0-9_]*)\??\s*:/gm)) {
        if (!found.has(f[1]!)) found.set(f[1]!, relative(root, file).split(sep).join('/'))
      }
    }
  }
  return found
}

const LINE = /^(#\s?)?([A-Z][A-Z0-9_]*)=$/

/** Names listed in .env.example, whether active or commented out. */
export function namesInExample(text: string): Set<string> {
  const names = new Set<string>()
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trim())
    if (m) names.add(m[2]!)
  }
  return names
}

const example = readFileSync(join(ROOT, '.env.example'), 'utf8')

test('every env var the code reads is listed in .env.example', () => {
  const listed = namesInExample(example)
  const missing = [...envVarsInCode()].filter(([name]) => !listed.has(name)).map(([name, file]) => `${name} (read in ${file})`)
  expect(missing).toEqual([])
})

test('.env.example holds names and comments only: no value after any equals sign', () => {
  const bad: string[] = []
  for (const [i, raw] of example.split('\n').entries()) {
    const line = raw.trim()
    if (line === '' || (line.startsWith('#') && !/^#\s?[A-Z][A-Z0-9_]*=/.test(line))) continue
    if (!LINE.test(line)) bad.push(`line ${i + 1}: ${line.replace(/=.*/, '=...')}`)
  }
  expect(bad).toEqual([])
})

test('the scanner finds the variables we know the app reads', () => {
  const found = envVarsInCode()
  for (const n of ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'GOOGLE_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'DEV_LOGIN', 'DUELWISE_DB', 'VITE_SENTRY_DSN', 'PORT', 'TRAINER_RUN_DIR']) {
    expect(found.has(n), n).toBe(true)
  }
  expect(found.has('DEV')).toBe(false)
})

test('the scanner flags a variable missing from an example (fixture)', () => {
  expect(namesInExample('# a comment\nFOO=\n# BAR=\nBAZ=secret\n')).toEqual(new Set(['FOO', 'BAR']))
})
