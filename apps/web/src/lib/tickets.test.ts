import { describe, expect, test } from 'bun:test'
import { LEDGER_KEEP_MS, OTHER_POOL, PLAYED_POOL, REPORT_AFTER_MS, ownsTicket, refillTickets, reportUnfinished, takeLocalTicket, usable, type Consumed, type ConsumedStore, type Ticket, type TicketApi, type TicketOwner, type TicketStore } from './tickets'

const NOW = 1_000_000
const V = () => 'v1'

function memory(initial: Ticket[] = []): TicketStore & { all(): Ticket[] } {
  const rows = new Map(initial.map((t) => [t.matchId, t]))
  return { async put(t) { rows.set(t.matchId, t) }, async list() { return [...rows.values()] }, async remove(id) { rows.delete(id) }, all: () => [...rows.values()] }
}
const GUEST: TicketOwner = { userId: null, guestId: 'g-1' }
const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({ owner: GUEST, matchId: id, game: 'four', level: 'easy', seed: 1, agentVersion: 'v1', expiresAt: NOW + 10_000, ...over })

describe('takeLocalTicket', () => {
  test('hands out the soonest-expiring usable ticket for the game and level, once', async () => {
    const store = memory([ticket('late', { expiresAt: NOW + 9000 }), ticket('soon', { expiresAt: NOW + 100 }), ticket('other-level', { level: 'hard' })])
    expect((await takeLocalTicket('four', 'easy', store, NOW, V))?.matchId).toBe('soon')
    expect((await takeLocalTicket('four', 'easy', store, NOW, V))?.matchId).toBe('late')
    expect(await takeLocalTicket('four', 'easy', store, NOW, V)).toBeNull()
    expect(store.all().map((t) => t.matchId)).toEqual(['other-level'])
  })

  test('skips an expired ticket and one issued for another agent version', async () => {
    const store = memory([ticket('old', { expiresAt: NOW - 1 }), ticket('v0', { agentVersion: 'v0' })])
    expect(await takeLocalTicket('four', 'easy', store, NOW, V)).toBeNull()
    expect(usable(ticket('x'), NOW, V)).toBe(true)
    expect(usable(ticket('x', { agentVersion: 'v2' }), NOW, V)).toBe(false)
  })
})

describe('refillTickets', () => {
  test('a ticket saved for chess, Four or Hold\'em before they lost offline tickets is dropped unused, and the server is never asked for one', async () => {
    const store = memory([ticket('old-four', { game: 'four' }), ticket('old-chess', { game: 'chess' }), ticket('old-holdem', { game: 'holdem' }), ticket('fighter-ok', { game: 'fighter' })])
    const asked: string[] = []
    const api: TicketApi = { async issue(input) { asked.push(input.game); return [] } }
    await refillTickets(['chess', 'four', 'holdem'], api, store, NOW)
    expect(asked).toEqual([])
    expect(store.all().map((t) => t.matchId)).toEqual(['fighter-ok'])
  })

  test('asks the server only for what each pool is missing and stores the answer', async () => {
    // Fighter still has tickets; chess, Four and Hold'em have none (rated-path.ts NO_OFFLINE_TICKETS).
    const store = memory([ticket('have-1', { game: 'fighter', agentVersion: 'v1' })])
    const asked: Array<{ game: string; level: string; count: number }> = []
    let n = 0
    const api: TicketApi = { async issue(input) { asked.push(input); return Array.from({ length: input.count }, () => ticket(`new-${n++}`, { game: input.game, level: input.level })) } }
    const added = await refillTickets(['fighter'], api, store, NOW)
    // Under Bun every version is 'v1', so the stored easy ticket counts and easy needs one fewer.
    expect(asked.every((a) => a.game === 'fighter' && a.count <= PLAYED_POOL)).toBe(true)
    expect(asked.map((a) => a.count)).toEqual([OTHER_POOL - 1, OTHER_POOL, OTHER_POOL, OTHER_POOL])
    expect(added).toBe(4 * OTHER_POOL - 1)
    expect(store.all()).toHaveLength(4 * OTHER_POOL)
  })

  test('never throws when the server is out of reach', async () => {
    const api: TicketApi = { async issue() { throw new Error('offline') } }
    expect(await refillTickets(['four'], api, memory(), NOW)).toBe(0)
  })

  test('Word Duel never asks for tickets', async () => {
    const asked: string[] = []
    const api: TicketApi = { async issue(i) { asked.push(i.game); return [] } }
    await refillTickets(['word'], api, memory(), NOW)
    expect(asked).toEqual([])
  })
})

function ledger(initial: Consumed[] = []): ConsumedStore & { all(): Consumed[] } {
  const rows = new Map(initial.map((c) => [c.matchId, c]))
  return { async put(c) { rows.set(c.matchId, c) }, async list() { return [...rows.values()] }, async remove(id) { rows.delete(id) }, all: () => [...rows.values()] }
}
const USER_U1 = { userId: 'u-1', guestId: 'g-1' }

describe('ticket owners', () => {
  test('a guest ticket serves the same browser after sign-in; a user ticket serves only that user', () => {
    expect(ownsTicket(GUEST, { userId: null, guestId: 'g-1' })).toBe(true)
    expect(ownsTicket(GUEST, USER_U1)).toBe(true)
    expect(ownsTicket(GUEST, { userId: null, guestId: 'g-2' })).toBe(false)
    expect(ownsTicket({ userId: 'u-1', guestId: null }, USER_U1)).toBe(true)
    expect(ownsTicket({ userId: 'u-1', guestId: null }, { userId: 'u-2', guestId: 'g-1' })).toBe(false)
    expect(ownsTicket({ userId: 'u-1', guestId: null }, { userId: null, guestId: 'g-1' })).toBe(false)
    expect(ownsTicket(undefined, USER_U1)).toBe(false)
  })

  test("takeLocalTicket never hands out another player's ticket", async () => {
    const store = memory([ticket('theirs', { owner: { userId: 'u-9', guestId: null } }), ticket('mine')])
    const book = ledger()
    expect((await takeLocalTicket('four', 'easy', store, NOW, V, USER_U1, book))?.matchId).toBe('mine')
    expect(await takeLocalTicket('four', 'easy', store, NOW, V, USER_U1, book)).toBeNull()
    expect(store.all().map((t) => t.matchId)).toEqual(['theirs'])
  })

  test('taking a ticket writes a ledger entry until the record is queued', async () => {
    const book = ledger()
    await takeLocalTicket('four', 'easy', memory([ticket('a')]), NOW, V, GUEST, book)
    expect(book.all()).toEqual([{ matchId: 'a', game: 'four', owner: GUEST, takenAt: NOW }])
  })

  test('refill drops tickets issued to a different player and counts only the viewer\'s own', async () => {
    const store = memory([ticket('theirs', { game: 'fighter', owner: { userId: 'u-9', guestId: null } }), ticket('legacy', { game: 'fighter', owner: undefined as never })])
    const asked: number[] = []
    const api: TicketApi = {
      async viewer() { return USER_U1 },
      async issue(input) { asked.push(input.count); return Array.from({ length: input.count }, (_, i) => ticket(`n-${input.level}-${i}`, { game: input.game, level: input.level, owner: { userId: 'u-1', guestId: null } })) },
    }
    await refillTickets(['fighter'], api, store, NOW, ledger())
    expect(store.all().some((t) => t.matchId === 'theirs' || t.matchId === 'legacy')).toBe(false)
    expect(asked).toEqual([OTHER_POOL, OTHER_POOL, OTHER_POOL, OTHER_POOL])
  })
})

describe('reportUnfinished', () => {
  const entry = (id: string, age: number, owner = GUEST): Consumed => ({ matchId: id, game: 'four', owner, takenAt: NOW - age })
  test('reports only the viewer\'s tickets that were taken long enough ago, and forgets what the server settled', async () => {
    const book = ledger([entry('old', REPORT_AFTER_MS + 1), entry('fresh', 1000), entry('theirs', REPORT_AFTER_MS + 1, { userId: 'u-9', guestId: null }), entry('ancient', LEDGER_KEEP_MS + 1)])
    const sent: string[][] = []
    const n = await reportUnfinished({ async issue() { return [] }, async abandon(ids) { sent.push(ids); return ids } }, book, USER_U1, NOW)
    expect(sent).toEqual([['old']])
    expect(n).toBe(1)
    expect(book.all().map((c) => c.matchId).sort()).toEqual(['fresh', 'theirs'])
  })
  test('keeps an entry when the report fails', async () => {
    const book = ledger([entry('old', REPORT_AFTER_MS + 1)])
    await reportUnfinished({ async issue() { return [] }, async abandon() { throw new Error('offline') } }, book, GUEST, NOW).catch(() => {})
    expect(book.all()).toHaveLength(1)
  })
})
