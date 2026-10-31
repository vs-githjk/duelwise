import { describe, expect, test } from 'bun:test'
import { isChunkError, judgeChunkFailure, recoverFromChunkError, reloadForStaleChunk, CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS } from './stale-chunk'
import { isMatchActive, setMatchActive, subscribeMatchActive } from './match-active'

const ORIGIN = 'https://duelwise.app'
const GONE = new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/assets/chess-abc.js`)

function fakeStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}
const blockedStore = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
const reply = (status: number, type: string) => (async () => new Response('x', { status, headers: { 'content-type': type } })) as unknown as typeof fetch
const never = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch

describe('isChunkError', () => {
  test('recognises the browsers\' words for a script chunk of this site that could not be fetched', () => {
    expect(isChunkError(GONE, ORIGIN)).toBe(true)
    for (const msg of [
      'error loading dynamically imported module: /assets/x.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/x.css',
      'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
    ]) expect(isChunkError(new TypeError(msg), ORIGIN)).toBe(true)
    expect(isChunkError('Failed to fetch dynamically imported module', ORIGIN)).toBe(true)
  })
  test('a module that loaded and then threw is a bug, not a stale chunk', () => {
    for (const msg of ['x is not defined', "Cannot read properties of undefined (reading 'a')", 'Unexpected token < in JSON', 'Failed to fetch']) expect(isChunkError(new Error(msg), ORIGIN)).toBe(false)
    expect(isChunkError(new SyntaxError(`The requested module '${ORIGIN}/assets/a.js' does not provide an export named 'b'`), ORIGIN)).toBe(false)
    expect(isChunkError(undefined, ORIGIN)).toBe(false)
  })
  test('only this site\'s /assets files count', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: https://cdn.example/assets/x.js'), ORIGIN)).toBe(false)
    expect(isChunkError(new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/api/thing.js`), ORIGIN)).toBe(false)
  })
})

describe('judgeChunkFailure', () => {
  test('no connection: offline, and the network is not even asked', async () => {
    expect(await judgeChunkFailure(GONE, { online: false, doFetch: never })).toBe('offline')
  })
  test('the probe cannot reach the server: offline', async () => {
    expect(await judgeChunkFailure(GONE, { online: true, doFetch: (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch })).toBe('offline')
  })
  test('a 404, or an HTML page where a script should be, is a stale asset', async () => {
    expect(await judgeChunkFailure(GONE, { online: true, doFetch: reply(404, 'application/javascript') })).toBe('stale')
    expect(await judgeChunkFailure(GONE, { online: true, doFetch: reply(200, 'text/html; charset=utf-8') })).toBe('stale')
  })
  test('a file that is there is not ours to fix', async () => {
    expect(await judgeChunkFailure(GONE, { online: true, doFetch: reply(200, 'application/javascript') })).toBe('fine')
  })
  test('probes with no-store, and with no URL falls back to a known asset, or does nothing', async () => {
    const seen: Array<[string, RequestInit | undefined]> = []
    const spy = (async (u: string, init?: RequestInit) => { seen.push([u, init]); return new Response('x', { status: 404 }) }) as unknown as typeof fetch
    expect(await judgeChunkFailure(new TypeError('Importing a module script failed.'), { online: true, doFetch: spy, knownAsset: () => `${ORIGIN}/assets/index-1.js` })).toBe('stale')
    expect(seen[0]![0]).toBe(`${ORIGIN}/assets/index-1.js`)
    expect(seen[0]![1]?.cache).toBe('no-store')
    expect(await judgeChunkFailure(new TypeError('Importing a module script failed.'), { online: true, doFetch: never, knownAsset: () => null })).toBe('fine')
  })
})

describe('reloadForStaleChunk', () => {
  test('reloads the first time and remembers it', async () => {
    const store = fakeStore()
    let reloads = 0
    expect(await reloadForStaleChunk({ store, now: () => 1000, forget: async () => {}, reload: () => { reloads++ } })).toBe(true)
    expect(reloads).toBe(1)
    expect(store.getItem(CHUNK_RELOAD_KEY)).toBe('1000')
  })
  test('does not reload again inside the window, so a chunk that is really gone cannot loop', async () => {
    const store = fakeStore({ [CHUNK_RELOAD_KEY]: '1000' })
    let reloads = 0
    expect(await reloadForStaleChunk({ store, now: () => 1000 + CHUNK_RELOAD_WINDOW_MS - 1, forget: async () => {}, reload: () => { reloads++ } })).toBe(false)
    expect(reloads).toBe(0)
  })
  test('reloads again once the window has passed', async () => {
    const store = fakeStore({ [CHUNK_RELOAD_KEY]: '1000' })
    let reloads = 0
    expect(await reloadForStaleChunk({ store, now: () => 1000 + CHUNK_RELOAD_WINDOW_MS + 1, forget: async () => {}, reload: () => { reloads++ } })).toBe(true)
    expect(reloads).toBe(1)
  })
  test('storage blocked (Safari private mode): never reloads on its own, caches untouched', async () => {
    let reloads = 0
    let forgot = 0
    expect(await reloadForStaleChunk({ store: blockedStore, now: () => 5, forget: async () => { forgot++ }, reload: () => { reloads++ } })).toBe(false)
    expect(await reloadForStaleChunk({ store: undefined, now: () => 5, forget: async () => { forgot++ }, reload: () => { reloads++ } })).toBe(false)
    expect(reloads + forgot).toBe(0)
  })
  test('drops the kept pages first, and still reloads when that fails', async () => {
    const order: string[] = []
    await reloadForStaleChunk({ store: fakeStore(), now: () => 5, forget: async () => { order.push('forget') }, reload: () => { order.push('reload') } })
    expect(order).toEqual(['forget', 'reload'])
    let reloaded = false
    expect(await reloadForStaleChunk({ store: fakeStore(), now: () => 5, forget: async () => { throw new Error('no caches') }, reload: () => { reloaded = true } })).toBe(true)
    expect(reloaded).toBe(true)
  })
})

describe('recoverFromChunkError', () => {
  const calls = () => {
    const c = { reload: 0, announce: 0 }
    return { c, o: { reload: (async () => { c.reload++; return true }) as typeof reloadForStaleChunk, announce: () => { c.announce++ } } }
  }
  // isChunkError reads location.origin when it exists; none exists under bun, and the test errors carry no foreign host.
  const GONE_HERE = new TypeError('Failed to fetch dynamically imported module')

  test('offline: no reload, nothing announced', async () => {
    const { c, o } = calls()
    expect(await recoverFromChunkError(GONE_HERE, { ...o, judge: async () => 'offline', matchActive: () => false })).toBe('offline')
    expect(c).toEqual({ reload: 0, announce: 0 })
  })
  test('stale during a match: announces the update and does not reload', async () => {
    const { c, o } = calls()
    expect(await recoverFromChunkError(GONE_HERE, { ...o, judge: async () => 'stale', matchActive: () => true })).toBe('deferred')
    expect(c).toEqual({ reload: 0, announce: 1 })
  })
  test('stale with no match: reloads once', async () => {
    const { c, o } = calls()
    expect(await recoverFromChunkError(GONE_HERE, { ...o, judge: async () => 'stale', matchActive: () => false })).toBe('reloaded')
    expect(c.reload).toBe(1)
  })
  test('stale but the page may not reload by itself: asks the player', async () => {
    expect(await recoverFromChunkError(GONE_HERE, { judge: async () => 'stale', matchActive: () => false, reload: async () => false })).toBe('ask')
  })
  test('a file that is fine, or an evaluation error, is left to the error boundary', async () => {
    const { c, o } = calls()
    expect(await recoverFromChunkError(GONE_HERE, { ...o, judge: async () => 'fine', matchActive: () => false })).toBe('fine')
    let judged = 0
    expect(await recoverFromChunkError(new ReferenceError('x is not defined'), { ...o, judge: async () => { judged++; return 'stale' }, matchActive: () => false })).toBe('ignored')
    expect(judged).toBe(0)
    expect(c).toEqual({ reload: 0, announce: 0 })
  })
})

describe('match-active flag', () => {
  test('is set and cleared, and tells subscribers only about changes', () => {
    let heard = 0
    const off = subscribeMatchActive(() => { heard++ })
    setMatchActive(true)
    setMatchActive(true)
    expect(isMatchActive()).toBe(true)
    setMatchActive(false)
    expect(isMatchActive()).toBe(false)
    expect(heard).toBe(2)
    off()
    setMatchActive(true)
    expect(heard).toBe(2)
    setMatchActive(false)
  })
})
