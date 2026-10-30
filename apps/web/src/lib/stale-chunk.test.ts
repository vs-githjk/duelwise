import { describe, expect, test } from 'bun:test'
import { isChunkError, reloadForStaleChunk, CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS } from './stale-chunk'

function fakeStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

describe('isChunkError', () => {
  test('recognises the browsers\' words for a script chunk that could not be loaded', () => {
    for (const msg of [
      'Failed to fetch dynamically imported module: https://duelwise.app/assets/chess-abc.js',
      'error loading dynamically imported module: /assets/x.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/x.css',
      'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
    ]) expect(isChunkError(new TypeError(msg))).toBe(true)
  })
  test('does not mistake other errors for one', () => {
    expect(isChunkError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isChunkError(new Error('x is undefined'))).toBe(false)
    expect(isChunkError(undefined)).toBe(false)
    expect(isChunkError('Failed to fetch dynamically imported module')).toBe(true)
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
  test('reloads again once the window has passed (a second deploy later in the session)', async () => {
    const store = fakeStore({ [CHUNK_RELOAD_KEY]: '1000' })
    let reloads = 0
    expect(await reloadForStaleChunk({ store, now: () => 1000 + CHUNK_RELOAD_WINDOW_MS + 1, forget: async () => {}, reload: () => { reloads++ } })).toBe(true)
    expect(reloads).toBe(1)
  })
  test('drops the kept pages first, and still reloads when that fails or storage is blocked', async () => {
    const order: string[] = []
    await reloadForStaleChunk({ store: fakeStore(), now: () => 5, forget: async () => { order.push('forget') }, reload: () => { order.push('reload') } })
    expect(order).toEqual(['forget', 'reload'])
    let reloaded = false
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
    expect(await reloadForStaleChunk({ store: blocked, now: () => 5, forget: async () => { throw new Error('no caches') }, reload: () => { reloaded = true } })).toBe(true)
    expect(reloaded).toBe(true)
  })
})
