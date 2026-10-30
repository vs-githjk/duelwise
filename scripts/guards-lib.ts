import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface Violation {
  file: string
  line: number
  rule: string
  text: string
}

interface BannedConfig {
  terms: string[]
  caseSensitive: string[]
  rejectedNames: string[]
}

const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)
const SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', '.output', '.git', '.vite', 'dist'])
const MAX_BYTES = 2 * 1024 * 1024
// R5: the honest-numbers guard errs toward flagging. The only exemptions are .css files (never scanned
// as web copy), Tailwind arbitrary values such as w-[50%], and a same-line "guard-allow: <reason>" marker.
const TAILWIND_ARBITRARY = /(?<=^|[\s"'`:!])-?[a-z][\w:-]*-\[[^\]\s"'`]+\]/g
const ALLOW_MARKER = /guard-allow:\s*\S/
const NUMBER_COPY = /(?<![\w.#-])\d[\d,.]*\s?(%|elo\b)/i

function stripAllowed(text: string): string {
  return text.replace(TAILWIND_ARBITRARY, ' ')
}

function loadConfig(): BannedConfig {
  return JSON.parse(readFileSync(join(import.meta.dir, 'banned-terms.json'), 'utf8'))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termRegex(term: string, caseSensitive: boolean): RegExp {
  const body = escapeRe(term).replace(/\\?[ ]/g, '[\\s_-]*')
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, caseSensitive ? '' : 'i')
}

function walk(dir: string, out: string[], excludeRel: (rel: string) => boolean, root: string): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const rel = relative(root, p).split(sep).join('/')
    if (excludeRel(rel)) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out, excludeRel, root)
    else if (st.isFile() && st.size <= MAX_BYTES) out.push(p)
  }
}

const BINARY_EXT = /\.(onnx|bin|pt|pth|npz|npy|dwht|wasm|png|jpe?g|webp|gif|glb|gltf|ktx2|mp3|ogg|wav|woff2?)$/i

function isText(path: string, buf: Buffer): boolean {
  if (BINARY_EXT.test(path)) return false
  return !buf.includes(0)
}

function childDirs(root: string, parent: string, sub: string): string[] {
  const base = join(root, parent)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((n) => !SKIP_DIRS.has(n) && statSync(join(base, n)).isDirectory())
    .map((n) => join(base, n, sub))
}

export function scanRoot(root: string): Violation[] {
  const cfg = loadConfig()
  const rules = [
    ...cfg.terms.map((t) => ({ rule: `banned term "${t}"`, re: termRegex(t, cfg.caseSensitive.includes(t)) })),
    ...cfg.rejectedNames.map((t) => ({ rule: `rejected name "${t}"`, re: termRegex(t, false) })),
  ]
  const files: string[] = []
  const exclude = (rel: string) => rel === 'scripts/banned-terms.json' || rel === 'docs/game-design' || rel.startsWith('docs/game-design/')
  const targets = [
    ...childDirs(root, 'apps', 'src'),
    ...childDirs(root, 'apps', 'public'),
    ...childDirs(root, 'packages', 'src'),
    join(root, 'training', 'trainer'),
    join(root, 'scripts'),
    join(root, 'docs'),
  ]
  for (const t of targets) walk(t, files, exclude, root)
  const readme = join(root, 'README.md')
  if (existsSync(readme)) files.push(readme)

  const out: Violation[] = []
  for (const f of files) {
    const buf = readFileSync(f)
    if (!isText(f, buf)) continue
    const rel = relative(root, f).split(sep).join('/')
    const webCopy = /^apps\/[^/]+\/src\/.*\.tsx?$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel) && !rel.endsWith('.gen.ts')
    const lines = buf.toString('utf8').split('\n')
    lines.forEach((text, i) => {
      const add = (rule: string) => out.push({ file: rel, line: i + 1, rule, text: text.trim().slice(0, 120) })
      if (text.includes(EM_DASH) || text.includes(EN_DASH)) add('em or en dash')
      for (const r of rules) if (r.re.test(text)) add(r.rule)
      if (webCopy && !ALLOW_MARKER.test(text) && NUMBER_COPY.test(stripAllowed(text))) add('numeric literal with % or Elo in web copy')
    })
  }
  return out
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const v = scanRoot(root)
  for (const x of v) console.error(`${x.file}:${x.line}: ${x.rule}: ${x.text}`)
  console.log(v.length === 0 ? 'guards: ok' : `guards: ${v.length} violation(s)`)
  process.exit(v.length === 0 ? 0 : 1)
}
