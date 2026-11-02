import { describe, expect, test } from 'bun:test'
import { beaconResign, clearResignedOnLeave, clearResignedOnRestore, listPending, postResign, readResignedOnLeave, resignOnPageLeave, retryPending, RESIGN_URL, savePending, type KeyValueStore } from './integrity'

describe('beaconResign', () => {
  test('sends the match id and tick to the resign endpoint', async () => {
    const seen: { url: string; body: string } = { url: '', body: '' }
    const ok = beaconResign('m-1', 12, {
      sendBeacon: (url: string | URL, data?: BodyInit | null) => {
        seen.url = String(url)
        void (data as Blob).text().then((t) => (seen.body = t))
        return true
      },
    })
    expect(ok).toBe(true)
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(seen).toEqual({ url: RESIGN_URL, body: JSON.stringify({ matchId: 'm-1', tick: 12 }) })
  })

  test('reports false without beacon support or when the browser throws', () => {
    expect(beaconResign('m', 1, {} as never)).toBe(false)
    expect(beaconResign('m', 1, { sendBeacon: () => { throw new Error('x') } })).toBe(false)
    expect(beaconResign('m', 1, undefined)).toBe(false)
  })
})

describe('postResign', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  test('returns the rating change', async () => {
    const r = await postResign('m', 3, reply(200, { resigned: true, elo: { before: 1000, after: 980 } }))
    expect(r.elo).toEqual({ before: 1000, after: 980 })
  })
  test('carries the unplayed mark of a match that never had a shot', async () => {
    expect((await postResign('m', 0, reply(200, { resigned: true, unplayed: true }))).unplayed).toBe(true)
  })
  test('throws the server message on an error', async () => {
    await expect(postResign('m', 3, reply(409, { error: 'match is already finished' }))).rejects.toThrow('already finished')
  })
})

describe('retryPending', () => {
  const memory = (): KeyValueStore => {
    const m = new Map<string, string>()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size } } as KeyValueStore
  }
  const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch
  test('drops an entry the server settled and keeps one that is still being checked (503)', async () => {
    const store = memory()
    savePending('settled', new Uint8Array([1]), store)
    savePending('claimed', new Uint8Array([2]), store)
    expect(await retryPending(store, answer(200))).toBe(2)
    expect(listPending(store)).toEqual([])
    savePending('claimed', new Uint8Array([2]), store)
    expect(await retryPending(store, answer(503))).toBe(0)
    expect(listPending(store).map((p) => p.matchId)).toEqual(['claimed'])
  })
})

describe('the resigned-on-leave note', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
  }
  const taken = { sendBeacon: () => true }
  const refused = { sendBeacon: () => false }

  test('a page leave the browser took leaves a note for that game only, and starting a match clears it', () => {
    const s = mem()
    expect(resignOnPageLeave('chess', 'm-1', 5, taken, s)).toBe(true)
    expect(readResignedOnLeave('chess', s)).toBe(true)
    expect(readResignedOnLeave('four', s)).toBe(false)
    clearResignedOnLeave(s)
    expect(readResignedOnLeave('chess', s)).toBe(false)
  })

  test('no note when the resignation was not actually sent, or nothing was left', () => {
    const s = mem()
    expect(resignOnPageLeave('chess', 'm-1', 5, refused, s)).toBe(false)
    expect(readResignedOnLeave('chess', s)).toBe(false)
    expect(readResignedOnLeave('chess', undefined)).toBe(false)
  })

  test('blocked storage never throws', () => {
    const bad = { setItem: () => { throw new Error('quota') }, getItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    expect(resignOnPageLeave('chess', 'm-1', 5, taken, bad)).toBe(true)
    expect(readResignedOnLeave('chess', bad)).toBe(false)
    expect(() => clearResignedOnLeave(bad)).not.toThrow()
  })
})

describe('the page-leave note, second round', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
  }
  const taken = { sendBeacon: () => true }
  test('a practice match is still resigned by beacon but leaves no note', () => {
    const s = mem()
    expect(resignOnPageLeave('chess', 'm-1', 5, taken, s, true)).toBe(true)
    expect(readResignedOnLeave('chess', s)).toBe(false)
  })
  test('a page restored from the back-forward cache drops the note; a normal load does not', () => {
    const s = mem()
    resignOnPageLeave('chess', 'm-1', 5, taken, s)
    clearResignedOnRestore(false, s)
    expect(readResignedOnLeave('chess', s)).toBe(true)
    clearResignedOnRestore(true, s)
    expect(readResignedOnLeave('chess', s)).toBe(false)
  })
})
