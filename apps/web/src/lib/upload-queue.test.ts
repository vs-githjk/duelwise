import { describe, expect, test } from 'bun:test'
import { drainUploads, enqueueUpload, REFUSED_KEEP_MS, type QueuedUpload, type UploadStore } from './upload-queue'

function memory(): UploadStore {
  const entries = new Map<string, QueuedUpload>()
  return { async put(item) { entries.set(item.matchId, item) }, async list() { return [...entries.values()] }, async remove(id) { entries.delete(id) } }
}
describe('upload queue', () => {
  test('deduplicates and removes acknowledged uploads', async () => {
    const store = memory()
    await enqueueUpload('one', new Uint8Array([1]), store)
    await enqueueUpload('one', new Uint8Array([2]), store)
    expect(await store.list()).toHaveLength(1)
    expect(await drainUploads(store, async () => 200, 1000)).toBe(1)
    expect(await store.list()).toHaveLength(0)
  })
  test('backs off after failure and retries when due', async () => {
    const store = memory()
    await enqueueUpload('one', new Uint8Array([1]), store)
    await drainUploads(store, async () => { throw Error('offline') }, 1000)
    expect((await store.list())[0]?.nextAttempt).toBe(3000)
    expect(await drainUploads(store, async () => 200, 2999)).toBe(0)
    expect(await drainUploads(store, async () => 200, 3000)).toBe(1)
  })
  test('keeps uploads when authentication needs attention', async () => {
    const store = memory()
    await enqueueUpload('one', new Uint8Array([1]), store)
    await drainUploads(store, async () => 401, 1000)
    expect(await store.list()).toHaveLength(1)
  })
  test('a 200 with valid false, a 410 and a 409 are settled but reported as not counted, with a reason', async () => {
    const store = memory()
    for (const id of ['valid', 'bad', 'gone', 'dup', 'same']) await enqueueUpload(id, new Uint8Array([1]), store, undefined, 0)
    const answers: Record<string, { status: number; valid?: boolean; reason?: string }> = {
      valid: { status: 200, valid: true },
      bad: { status: 200, valid: false, reason: 'the opponent was updated' },
      gone: { status: 410 },
      dup: { status: 409 },
      same: { status: 409, valid: true },
    }
    const ids = ['valid', 'bad', 'gone', 'dup', 'same']
    let i = 0
    let detail: { outcomes: Array<{ matchId: string; counted: boolean; reason?: string }> } | undefined
    const g = globalThis as unknown as { window?: unknown; CustomEvent?: unknown }
    const before = { window: g.window, CustomEvent: g.CustomEvent }
    g.window = { dispatchEvent: (e: { detail: typeof detail }) => { detail = e.detail } }
    g.CustomEvent = class { constructor(public type: string, public init: { detail: unknown }) {} get detail() { return this.init.detail } }
    try {
      expect(await drainUploads(store, async () => answers[ids[i++]!]!, 1000, null)).toBe(5)
    } finally {
      g.window = before.window
      g.CustomEvent = before.CustomEvent
    }
    expect(detail!.outcomes.map((o) => [o.matchId, o.counted])).toEqual([['valid', true], ['bad', false], ['gone', false], ['dup', false], ['same', true]])
    expect(detail!.outcomes[1]!.reason).toBe('the opponent was updated')
    expect(detail!.outcomes[2]!.reason).toContain('expired')
  })
  test('a record that keeps getting 403 is kept at first and dropped once its ticket could not count any more', async () => {
    const store = memory()
    await enqueueUpload('one', new Uint8Array([1]), store, undefined, 0)
    expect(await drainUploads(store, async () => 403, 1000, null)).toBe(0)
    expect(await store.list()).toHaveLength(1)
    expect(await drainUploads(store, async () => 403, REFUSED_KEEP_MS + 10_000_000, null)).toBe(1)
    expect(await store.list()).toHaveLength(0)
  })
  test("another player's record is not sent while they are signed in", async () => {
    const store = memory()
    await enqueueUpload('theirs', new Uint8Array([1]), store, { userId: 'u-9', guestId: null }, 0)
    let sent = 0
    expect(await drainUploads(store, async () => { sent++; return 200 }, 1000, { userId: 'u-1', guestId: 'g-1' })).toBe(0)
    expect(sent).toBe(0)
    expect(await store.list()).toHaveLength(1)
    expect(await drainUploads(store, async () => { sent++; return 200 }, 1000, { userId: 'u-9', guestId: null })).toBe(1)
  })
})
