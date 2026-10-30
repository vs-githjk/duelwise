/**
 * Assembles THIRD_PARTY.md from docs/third-party/*.md and checks that every credit is there.
 *
 *   bun scripts/third-party.ts            rewrite THIRD_PARTY.md
 *   bun scripts/third-party.ts --check    print what is missing and exit 1 if anything is, writes nothing
 *
 * Re-run it whenever a file in docs/third-party changes or an asset pack is added.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ASSETS = 'apps/web/public/assets'
const SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', '.output', '.git', '.vite', 'dist', 'test-results', 'runs', 'plan'])
const CODE_FILE = /\.(ts|tsx|mjs|js|py)$/
const LICENCE_FILE = /^(licen[sc]e|copying|notice)/i
// A copied file keeps its original licence header; an ordinary file of ours has none of these.
const LICENCE_HEADER = /SPDX-License-Identifier|Copyright\s*(\(c\)|©)|licensed under|\bMIT License\b/i
const HEADER_LINES = 40

export interface PackFolder {
  category: string
  source: string
  pack: string
  /** Repo-relative, forward slashes. */
  path: string
}

const rel = (root: string, p: string): string => relative(root, p).split(sep).join('/')

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort()
}

/** Every <category>/<source>/<pack> folder under apps/web/public/assets. */
export function packFolders(root: string): PackFolder[] {
  const out: PackFolder[] = []
  const base = join(root, ASSETS)
  for (const category of subdirs(base)) {
    for (const source of subdirs(join(base, category))) {
      for (const pack of subdirs(join(base, category, source))) {
        out.push({ category, source, pack, path: `${ASSETS}/${category}/${source}/${pack}` })
      }
    }
  }
  return out
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (st.isFile() && CODE_FILE.test(name) && st.size <= 2 * 1024 * 1024) out.push(p)
  }
}

/** Source files that carry another project's licence header in their first lines. */
export function copiedCodeFiles(root: string): string[] {
  const files: string[] = []
  for (const d of ['apps', 'packages', 'scripts', 'training']) walk(join(root, d), files)
  return files
    .filter((f) => !f.endsWith(`${sep}third-party.ts`) && !f.endsWith(`${sep}third-party.test.ts`))
    .filter((f) => readFileSync(f, 'utf8').split('\n').slice(0, HEADER_LINES).some((l) => LICENCE_HEADER.test(l)))
    .map((f) => rel(root, f))
}

/** What is missing from `credits` (the text of THIRD_PARTY.md): uncredited packs, packs without a licence file, uncredited copied code. */
export function findProblems(root: string, credits: string): string[] {
  const text = credits.toLowerCase()
  const problems: string[] = []
  for (const p of packFolders(root)) {
    if (!text.includes(p.source.toLowerCase()) || !text.includes(p.pack.toLowerCase())) {
      problems.push(`asset pack ${p.path} has no credit naming "${p.source}" and "${p.pack}"`)
    }
    const hasLicence = readdirSync(join(root, p.path)).some((n) => LICENCE_FILE.test(n) && statSync(join(root, p.path, n)).isFile())
    if (!hasLicence) problems.push(`asset pack ${p.path} has no licence file saved next to its files`)
  }
  for (const f of copiedCodeFiles(root)) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    if (!text.includes(f.toLowerCase()) && !text.includes(base.toLowerCase())) problems.push(`copied code ${f} has no credit naming its path or file name`)
  }
  return problems
}

export interface DependencyLicence {
  name: string
  version: string
  license: string
}

/** Direct dependencies of the root, apps/web and every packages/* manifest, with the licence the installed package declares. */
export function dependencyLicences(root: string): DependencyLicence[] {
  const manifests = [join(root, 'package.json'), join(root, 'apps', 'web', 'package.json')]
  for (const d of subdirs(join(root, 'packages'))) manifests.push(join(root, 'packages', d, 'package.json'))
  const found = new Map<string, DependencyLicence>()
  for (const m of manifests) {
    if (!existsSync(m)) continue
    const dir = resolve(m, '..')
    const json = JSON.parse(readFileSync(m, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    for (const name of Object.keys({ ...json.dependencies, ...json.devDependencies })) {
      if (found.has(name) || name.startsWith('@duelwise/')) continue
      let info: { version?: string; license?: unknown } | null = null
      for (const base of [dir, root]) {
        const f = join(base, 'node_modules', name, 'package.json')
        if (existsSync(f)) {
          info = JSON.parse(readFileSync(f, 'utf8'))
          break
        }
      }
      const lic = info?.license
      found.set(name, { name, version: info?.version ?? 'unknown', license: typeof lic === 'string' && lic ? lic : 'unknown' })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Moves every Markdown heading down one level, leaving fenced code alone. */
function demote(md: string): string {
  let fenced = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced
      return !fenced && /^#{1,5}\s/.test(line) ? `#${line}` : line
    })
    .join('\n')
}

/** The full text of THIRD_PARTY.md for a checkout. */
export function assemble(root: string): string {
  const dir = join(root, 'docs', 'third-party')
  const topics = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : []
  const out: string[] = [
    '# Third-party notices',
    '',
    'Generated by `bun scripts/third-party.ts` from `docs/third-party/*.md` and the installed dependencies. Edit those files, not this one.',
    'Every asset pack lives in its own folder under `apps/web/public/assets/<category>/<source>/<pack>/` with its licence file beside it.',
    '',
  ]
  for (const t of topics) {
    out.push(demote(readFileSync(join(dir, t), 'utf8').trim()), '')
  }
  const deps = dependencyLicences(root)
  out.push(
    '## Software dependencies',
    '',
    'Direct dependencies of the web app and its workspace packages, with the licence each installed package declares in its own `package.json`. Transitive dependencies keep their own licences inside `node_modules`. The Python training dependencies in `training/pyproject.toml` are never shipped to browsers.',
    '',
    '| Package | Version | Licence |',
    '| --- | --- | --- |',
    ...deps.map((d) => `| ${d.name} | ${d.version} | ${d.license} |`),
    '',
  )
  return out.join('\n')
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const check = Bun.argv.includes('--check')
  const next = assemble(root)
  const target = join(root, 'THIRD_PARTY.md')
  if (!check) {
    writeFileSync(target, next)
    console.log(`wrote ${target}`)
  }
  const current = check ? (existsSync(target) ? readFileSync(target, 'utf8') : '') : next
  const problems = findProblems(root, current)
  if (check && current !== next) problems.push('THIRD_PARTY.md is out of date: run bun scripts/third-party.ts')
  for (const p of problems) console.error(`third-party: ${p}`)
  if (problems.length > 0) process.exit(1)
  console.log('third-party: every pack and copied file is credited')
}
