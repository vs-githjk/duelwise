// Builds the precache list for the service worker (sw/sw.js) from the finished build, and writes the worker next to it.
// Runs from the Nitro `compiled` hook in vite.config.ts, so it sees the final public folder whatever the deploy preset.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface PrecacheList {
  /** Changes whenever any precached file changes; names the caches. */
  version: string
  /** Needed for the app to run offline. If one cannot be fetched the install fails and the old worker stays. */
  required: string[]
  /** Big or optional art and models. A failed fetch is skipped; the worker caches them on first use instead. */
  optional: string[]
  /** Server-rendered pages cached at install so the first offline open works (best effort). */
  pages: string[]
}

/** Files that must never be precached: the worker itself and source maps. */
const SKIP = (url: string) => url === '/sw.js' || url.endsWith('.map') || url.endsWith('.DS_Store')

/** What the app cannot start without. Everything else (models, 3D art, audio) is optional at install and cached on first use. */
const REQUIRED_EXT = new Set(['.js', '.mjs', '.css', '.woff2', '.ttf', '.webmanifest', '.svg', '.png', '.wasm'])
const OPTIONAL_UNDER = ['/agents/', '/assets/arena/', '/assets/fighter/']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const ext = (url: string) => url.slice(url.lastIndexOf('.')).toLowerCase()

/**
 * Lists every file in the built public folder as a URL, split into required and optional, and hashes them into a version.
 * `pages` is passed in (the play pages come from the product table), not read from disk, because they are server rendered.
 */
export function buildPrecacheList(publicDirs: string | readonly string[], pages: readonly string[] = []): PrecacheList {
  // Several folders can make up the site (the client build and the project's public folder); a URL in an earlier one wins.
  const files = new Map<string, string>()
  for (const dir of typeof publicDirs === 'string' ? [publicDirs] : publicDirs) {
    for (const f of walk(dir)) {
      const url = '/' + relative(dir, f).split(sep).join('/')
      if (!SKIP(url) && !files.has(url)) files.set(url, f)
    }
  }
  const urls = [...files.keys()].sort()
  const hash = createHash('sha256')
  for (const u of urls) {
    hash.update(u)
    hash.update(createHash('sha256').update(readFileSync(files.get(u)!)).digest())
  }
  for (const p of pages) hash.update('page:' + p)
  const required: string[] = []
  const optional: string[] = []
  for (const u of urls) {
    const big = OPTIONAL_UNDER.some((p) => u.startsWith(p)) || !REQUIRED_EXT.has(ext(u))
    ;(big ? optional : required).push(u)
  }
  return { version: hash.digest('hex').slice(0, 12), required, optional, pages: [...pages] }
}

const PLACEHOLDER = '"__DUELWISE_PRECACHE__"'

/** Fills the worker template with the list. Throws if the template has no placeholder, so a broken template fails the build. */
export function renderServiceWorker(template: string, list: PrecacheList, build = ''): string {
  if (!template.includes(PLACEHOLDER)) throw new Error('sw template has no precache placeholder')
  return template.replace(PLACEHOLDER, JSON.stringify({ ...withWorkerVersion(template, list), build }))
}

/** The cache version also covers the worker's own code, so changing only the worker still replaces the caches. */
export function withWorkerVersion(template: string, list: PrecacheList): PrecacheList {
  return { ...list, version: createHash('sha256').update(list.version).update(template).digest('hex').slice(0, 12) }
}

/**
 * Reads sw/sw.js, fills it from the site and writes `<publicDir>/sw.js`. `extraDirs` are further folders served at the site root
 * (the project's public folder). Returns the list.
 */
export function writeServiceWorker(publicDir: string, templatePath: string, pages: readonly string[], extraDirs: readonly string[] = [], build = ''): PrecacheList {
  statSync(publicDir)
  const list = buildPrecacheList([publicDir, ...extraDirs], pages)
  const template = readFileSync(templatePath, 'utf8')
  writeFileSync(join(publicDir, 'sw.js'), renderServiceWorker(template, list, build))
  return withWorkerVersion(template, list)
}
