import { describe, expect, test } from 'bun:test'
import { forgetPrivateData, onWorkerMessage } from './pwa'
import { QUEUE_EVENT } from './upload-queue'
import { looksOffline } from '../components/ErrorBoundary'

describe('worker messages', () => {
  test('a settled-queue message becomes the page event; a drain request drains', () => {
    const events: Event[] = []
    let drains = 0
    onWorkerMessage({ type: 'QUEUE_SETTLED', matchIds: ['a', 'b'] }, (e) => events.push(e), () => drains++)
    onWorkerMessage({ type: 'DRAIN' }, (e) => events.push(e), () => drains++)
    onWorkerMessage({ type: 'nonsense' }, (e) => events.push(e), () => drains++)
    onWorkerMessage(null, (e) => events.push(e), () => drains++)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe(QUEUE_EVENT)
    expect((events[0] as CustomEvent).detail).toEqual({ matchIds: ['a', 'b'], outcomes: [{ matchId: 'a', counted: true }, { matchId: 'b', counted: true }] })
    expect(drains).toBe(1)
  })
})

describe('looksOffline', () => {
  test('the browser being offline, or a failed fetch, is the connection; other errors are bugs', () => {
    expect(looksOffline(new Error('x'), { onLine: false })).toBe(true)
    expect(looksOffline(new TypeError('Failed to fetch'), { onLine: true })).toBe(true)
    expect(looksOffline(new Error('boom'), { onLine: true })).toBe(false)
    expect(looksOffline(undefined, undefined)).toBe(false)
  })
})

describe('forgetPrivateData', () => {
  test('sign-out deletes the cached pages (they carry the viewer) and the remembered viewer, and leaves other caches alone', async () => {
    const g = globalThis as unknown as { caches?: unknown; localStorage?: unknown }
    const before = { caches: g.caches, localStorage: g.localStorage }
    const names = new Set(['duelwise-pages-abc', 'duelwise-static-abc', 'other'])
    const store = new Map<string, string>([['duelwise.ticket-viewer', '{"userId":"u-1","guestId":null}']])
    g.caches = { keys: async () => [...names], delete: async (n: string) => names.delete(n) }
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
    try {
      await forgetPrivateData()
    } finally {
      g.caches = before.caches
      g.localStorage = before.localStorage
    }
    expect([...names].sort()).toEqual(['duelwise-static-abc', 'other'])
    expect(store.has('duelwise.ticket-viewer')).toBe(false)
  })
})
