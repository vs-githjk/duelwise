import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { buildPrecacheList, renderServiceWorker, writeServiceWorker } from './sw-precache'

const dirs: string[] = []
function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'duelwise-sw-'))
  dirs.push(dir)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const BUILD = {
  'assets/index-abc123.js': 'a',
  'assets/index-abc123.css': 'b',
  'assets/ort-wasm-simd-threaded-1f2e.wasm': 'w',
  'assets/ort-wasm-simd-threaded-1f2e.mjs': 'm',
  'assets/fighter/hero.glb': 'g',
  'fonts/geist-latin.woff2': 'f',
  'fonts/OFL-Geist.txt': 'license',
  'icons/icon-192.png': 'i',
  'personas/pip.svg': 's',
  'agents/four/v1/easy.onnx': 'o',
  'agents/chess/v1/value.bin': 'o2',
  'manifest.webmanifest': '{}',
  'sw.js': 'old worker',
  'assets/index-abc123.js.map': 'map',
}

describe('buildPrecacheList', () => {
  test('lists the built files as URLs, required before optional, without the worker or source maps', () => {
    const list = buildPrecacheList(site(BUILD), ['/', '/play'])
    expect(list.required).toEqual([
      '/assets/index-abc123.css',
      '/assets/index-abc123.js',
      '/assets/ort-wasm-simd-threaded-1f2e.mjs',
      '/assets/ort-wasm-simd-threaded-1f2e.wasm',
      '/fonts/geist-latin.woff2',
      '/icons/icon-192.png',
      '/manifest.webmanifest',
      '/personas/pip.svg',
    ])
    expect(list.optional).toEqual(['/agents/chess/v1/value.bin', '/agents/four/v1/easy.onnx', '/assets/fighter/hero.glb', '/fonts/OFL-Geist.txt'])
    expect(list.pages).toEqual(['/', '/play'])
    const all = [...list.required, ...list.optional]
    expect(all).not.toContain('/sw.js')
    expect(all.some((u) => u.endsWith('.map'))).toBe(false)
  })

  test('every ONNX model and the onnxruntime wasm are in the list', () => {
    const list = buildPrecacheList(site(BUILD))
    expect([...list.required, ...list.optional].filter((u) => u.endsWith('.onnx'))).toHaveLength(1)
    expect(list.required.some((u) => u.endsWith('.wasm'))).toBe(true)
  })

  test('the version changes when a file changes and is stable otherwise', () => {
    const a = buildPrecacheList(site(BUILD)).version
    expect(buildPrecacheList(site(BUILD)).version).toBe(a)
    expect(buildPrecacheList(site({ ...BUILD, 'assets/index-abc123.js': 'changed' })).version).not.toBe(a)
    expect(buildPrecacheList(site(BUILD), ['/play']).version).not.toBe(a)
  })
})

describe('renderServiceWorker and writeServiceWorker', () => {
  const template = readFileSync(join(import.meta.dirname, '..', 'sw', 'sw.js'), 'utf8')

  test('the real template has its placeholder and an unfilled template is refused', () => {
    expect(template).toContain('"__DUELWISE_PRECACHE__"')
    expect(() => renderServiceWorker('const x = 1', { version: 'v', required: [], optional: [], pages: [] })).toThrow()
  })

  test('writes /sw.js into the public folder with the list inside', () => {
    const dir = site(BUILD)
    const list = writeServiceWorker(dir, join(import.meta.dirname, '..', 'sw', 'sw.js'), ['/play'])
    const written = readFileSync(join(dir, 'sw.js'), 'utf8')
    expect(written).not.toContain('__DUELWISE_PRECACHE__')
    expect(written).toContain(list.version)
    expect(written).toContain('/assets/index-abc123.js')
    expect(() => new vm.Script(written)).not.toThrow()
  })
})

describe('the worker routes requests', () => {
  // Load the worker in a sandbox with a fake worker scope and read back its pure routing function.
  const source = readFileSync(join(import.meta.dirname, '..', 'sw', 'sw.js'), 'utf8').replace('"__DUELWISE_PRECACHE__"', '{"version":"t","required":[],"optional":[],"pages":[]}')
  const sandbox: Record<string, unknown> = { self: { addEventListener() {}, location: { origin: 'https://duelwise.test' } }, URL, Response, caches: {}, fetch: () => {}, indexedDB: {} }
  vm.createContext(sandbox)
  vm.runInContext(source + '\nthis.strategyFor = strategyFor', sandbox)
  const route = (path: string, method = 'GET', mode = 'cors', origin = 'https://duelwise.test') =>
    (sandbox.strategyFor as (u: URL, m: string, mode: string, o: string) => string)(new URL(path, origin), method, mode, 'https://duelwise.test')

  test('pages go network first; the player\'s own pages are never kept', () => {
    expect(route('/play/four-in-a-row', 'GET', 'navigate')).toBe('navigate')
    expect(route('/leaderboard/chess', 'GET', 'navigate')).toBe('navigate')
    for (const p of ['/settings', '/owner', '/signin', '/report/abc', '/report-card/abc']) expect(route(p, 'GET', 'navigate')).toBe('navigate-private')
  })

  test('hashed files, models, fonts and wasm are cache first', () => {
    for (const p of ['/assets/index-abc.js', '/agents/four/v1/easy.onnx', '/fonts/geist-latin.woff2', '/_resvg/index_bg.wasm', '/personas/pip.svg', '/manifest.webmanifest']) expect(route(p)).toBe('static')
  })

  test('server calls, uploads, other methods and other origins are left alone', () => {
    expect(route('/_serverFn/abc')).toBe('pass')
    expect(route('/api/finish', 'POST')).toBe('pass')
    expect(route('/api/finish')).toBe('pass')
    expect(route('/assets/x.js', 'POST')).toBe('pass')
    expect(route('/assets/x.js', 'GET', 'cors', 'https://cdn.example')).toBe('pass')
    expect(route('/sw.js')).toBe('pass')
  })
})

describe('the worker never mixes deploys on a page load', () => {
  const template = readFileSync(join(import.meta.dirname, '..', 'sw', 'sw.js'), 'utf8').replace('"__DUELWISE_PRECACHE__"', '{"version":"t","required":[],"optional":[],"pages":[]}').replace('const NAV_TIMEOUT_MS = 4000', 'const NAV_TIMEOUT_MS = 30')
  const htmlOf = (entry: string) => `<!doctype html><link rel="modulepreload" href="${entry}"><script type="module" src="${entry}"></script><link rel="stylesheet" href="/assets/app-aaa.css">`
  const OLD = htmlOf('/assets/index-OLD.js')
  const NEW = htmlOf('/assets/index-NEW.js')

  /** A worker scope with fake caches. `network` is what fetch does for the page. */
  function load(opts: { pages: Record<string, string>; statics: string[]; network: () => Promise<Response> }) {
    const store = (map: Map<string, Response>) => ({
      match: async (key: string | Request) => map.get(typeof key === 'string' ? key : new URL(key.url).pathname)?.clone(),
      put: async (key: string | Request, res: Response) => void map.set(typeof key === 'string' ? key : new URL(key.url).pathname, res),
    })
    const pagesMap = new Map(Object.entries(opts.pages).map(([k, v]) => [k, new Response(v, { headers: { 'content-type': 'text/html' } })]))
    const staticMap = new Map(opts.statics.map((k) => [k, new Response('x')]))
    const sandbox: Record<string, unknown> = {
      self: { addEventListener() {}, location: { origin: 'https://duelwise.test' } }, URL, Response, indexedDB: {}, setTimeout, clearTimeout,
      caches: { open: async (name: string) => store(name.includes('pages') ? pagesMap : staticMap) },
      fetch: opts.network,
    }
    vm.createContext(sandbox)
    vm.runInContext(template + '\nthis.navigate = navigate; this.assetUrlsIn = assetUrlsIn', sandbox)
    return sandbox as { navigate: (r: Request | { url: string }, keep: boolean) => Promise<Response>; assetUrlsIn: (h: string) => string[] }
  }
  const req = { url: 'https://duelwise.test/play/chess' }

  test('lists the scripts and styles a page names', () => {
    const w = load({ pages: {}, statics: [], network: async () => new Response('') })
    expect(w.assetUrlsIn(NEW).sort()).toEqual(['/assets/app-aaa.css', '/assets/index-NEW.js'])
    expect(w.assetUrlsIn('<p>no files</p>')).toEqual([])
  })

  test('a slow network with a saved copy from THIS deploy serves the copy', async () => {
    const w = load({ pages: { '/play/chess': OLD }, statics: ['/assets/index-OLD.js', '/assets/app-aaa.css'], network: () => new Promise(() => {}) })
    expect(await (await w.navigate(req, true)).text()).toBe(OLD)
  })

  test('a slow network with a saved copy from ANOTHER deploy waits for the real page instead of serving the stale one', async () => {
    const w = load({ pages: { '/play/chess': NEW }, statics: ['/assets/index-OLD.js', '/assets/app-aaa.css'], network: () => new Promise((r) => setTimeout(() => r(new Response(OLD)), 80)) })
    expect(await (await w.navigate(req, true)).text()).toBe(OLD)
  })

  test('offline with a stale copy shows the calm offline page, never a page whose files are missing', async () => {
    const w = load({ pages: { '/play/chess': NEW }, statics: ['/assets/index-OLD.js', '/assets/app-aaa.css'], network: async () => { throw new TypeError('Failed to fetch') } })
    expect(await (await w.navigate(req, true)).text()).toContain('You are offline')
  })

  test('offline with a usable copy still opens the game', async () => {
    const w = load({ pages: { '/play/chess': OLD }, statics: ['/assets/index-OLD.js', '/assets/app-aaa.css'], network: async () => { throw new TypeError('Failed to fetch') } })
    expect(await (await w.navigate(req, true)).text()).toBe(OLD)
  })
})
