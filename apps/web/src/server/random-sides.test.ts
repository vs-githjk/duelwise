import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId } from '@duelwise/core/src/product'
import { sideForSeed } from '@duelwise/core/src/sides'
import type { Seat } from '@duelwise/core/src/types'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { checkAgentMoves } from './agent-check'
import { fakeAgent, play } from './agent-check-fixtures'
import { finishMatchHandler, startMatchHandler, type Caller, type FinishBody, type FinishOptions, type StartBody } from './match-handlers'
import { issueTicketsHandler, type Ticket } from './ticket-issue'

type Db = PgliteDatabase<typeof schema>
let client: PGlite
let db: Db

beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, guest, rating, profile, "user", match_report, telemetry_event cascade`)
  await db.insert(schema.guest).values({ id: 'g-1' })
  await db.insert(schema.user).values({ id: 'u-1', name: 'Rival', email: 'u-1@example.test' })
})

const USER: Caller = { userId: 'u-1' }
const RANDOM = ['chess', 'four', 'slack'] as const
const CHECKED: FinishOptions = { verifyAgent: (rec) => checkAgentMoves(rec, { makeAgent: async (g) => fakeAgent(g) }) }
const body = (r: { body: unknown }) => r.body as FinishBody
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
const ratingOf = async (game: GameId) => (await db.select().from(schema.rating).where(and(eq(schema.rating.userId, 'u-1'), eq(schema.rating.game, game))))[0]

/** The first seed from `from` on that the server turns into `side`. */
function seedFor(game: GameId, side: Seat, from = 1): number {
  for (let s = from; ; s++) if (sideForSeed(game, s) === side) return s
}

async function begin(game: GameId, seed: number, extra: Record<string, unknown> = {}, who: Caller = USER) {
  const r = await startMatchHandler(db, { game, level: 'hard', sides: 1, ...extra }, who, { agentVersion: () => 'v1', seed: () => seed })
  expect(r.status).toBe(200)
  return r.body as StartBody
}

describe('the server gives the player a side at the start', () => {
  for (const game of RANDOM) {
    test(`${game}: both sides are reachable, the reply and the stored row agree, and the same seed gives the same side`, async () => {
      for (const side of [0, 1] as const) {
        const seed = seedFor(game, side)
        const m = await begin(game, seed)
        expect(m.humanSeat).toBe(side)
        expect((await rowOf(m.matchId)).filterFlags).toEqual({ humanSeat: side })
        expect((await begin(game, seed)).humanSeat).toBe(side)
      }
    })

    test(`${game}: a practice start gets a side too and keeps its practice flag`, async () => {
      const seed = seedFor(game, 1)
      const m = await begin(game, seed, { practice: true })
      expect(m.humanSeat).toBe(1)
      expect((await rowOf(m.matchId)).filterFlags).toEqual({ practice: true, humanSeat: 1 })
    })
  }

  test('with real randomness both sides come up', async () => {
    const seen = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const r = await startMatchHandler(db, { game: 'four', level: 'easy', sides: 1, practice: true }, USER, { agentVersion: () => 'v1' })
      seen.add((r.body as StartBody).humanSeat!)
    }
    expect([...seen].sort()).toEqual([0, 1])
  })

  test('the other games are untouched: no side in the reply and no flag in the row', async () => {
    for (const game of ['holdem', 'fleet', 'word', 'fighter', 'arena'] as const) {
      const m = await begin(game, 5)
      expect(m.humanSeat).toBeUndefined()
      expect((await rowOf(m.matchId)).filterFlags ?? null).not.toHaveProperty('humanSeat')
    }
  })

  // Chess no longer gets tickets (rated-path.ts), so this is a ticket as the server issued it before that rule.
  test('an offline ticket carries the side it was issued with, and it is the same one the row holds', async () => {
    const seed = seedFor('chess', 1)
    const r = await issueTicketsHandler(db, { game: 'chess', level: 'hard', sides: 1, count: 1 }, USER, { agentVersion: () => 'v1', seed: () => seed, noTickets: [] })
    const [t] = (r.body as { tickets: Ticket[] }).tickets
    expect(t!.humanSeat).toBe(1)
    expect((await rowOf(t!.matchId)).filterFlags).toMatchObject({ humanSeat: 1 })
  })
})

describe('the finish step holds the record to the issued side', () => {
  for (const game of RANDOM) {
    test(`${game}: an honest record played as the second mover (the agent moves first) is valid and moves the rating on a win`, async () => {
      let counted = 0
      for (let seed = seedFor(game, 1); counted < 2 && seed < 400; seed = seedFor(game, 1, seed + 1)) {
        const m = await begin(game, seed)
        const rec = await play(game, seed, undefined, 'hard', m.matchId, 1)
        expect(rec.actions[0]![1]).toBe(0)
        expect(rec.humanSeat).toBe(1)
        const r = body(await finishMatchHandler(db, encodeRecord(rec), USER, CHECKED))
        expect(r.valid, r.reason).toBe(true)
        // The human is seat 1 here, so a seat 1 win raises the rating and a seat 0 (agent) win lowers it.
        if (rec.result.winner === 1) expect(r.elo!.after).toBeGreaterThan(r.elo!.before)
        if (rec.result.winner === 0) expect(r.elo!.after).toBeLessThan(r.elo!.before)
        counted++
      }
      expect(counted).toBe(2)
    })

    test(`${game}: an agent move forged while the agent has the first move is caught`, async () => {
      const seed = seedFor(game, 1)
      const m = await begin(game, seed)
      const rec = await play(game, seed, 0, 'hard', m.matchId, 1)
      const r = body(await finishMatchHandler(db, encodeRecord(rec), USER, CHECKED))
      expect(r.valid).toBe(false)
      expect(r.reason).toContain('the seeded agent plays')
    })

    test(`${game}: a record from the other seat than the issued one is invalid and costs the loss, both ways round`, async () => {
      for (const [issued, claimed] of [[1, 0], [0, 1]] as const) {
        await db.execute(sql`truncate table match, rating cascade`)
        const seed = seedFor(game, issued)
        const m = await begin(game, seed)
        const rec = await play(game, seed, undefined, 'hard', m.matchId, claimed)
        const r = body(await finishMatchHandler(db, encodeRecord(rec), USER, CHECKED))
        expect(r.valid).toBe(false)
        expect(r.reason).toContain(`issued seat ${issued}, record says seat ${claimed}`)
        expect(r.elo!.after).toBeLessThan(r.elo!.before)
        expect((await rowOf(m.matchId)).record).toBeNull()
      }
    })

    test(`${game}: a row made before sides existed (no flag) is seat 0: a seat 0 record counts and a seat 1 record does not`, async () => {
      const seed = seedFor(game, 1)
      for (const [id, seat] of [['old-0', 0], ['old-1', 1]] as const) {
        await db.insert(schema.match).values({ id, game, userId: 'u-1', agentVersion: 'v1', level: 'hard', seed, status: 'started' })
        const rec = await play(game, seed, undefined, 'hard', id, seat)
        const r = body(await finishMatchHandler(db, encodeRecord(rec), USER, CHECKED))
        expect(r.valid, r.reason).toBe(seat === 0)
      }
    })
  }

  test('the agent check runs the opponent as the other seat: it is asked for seat 0 when the player is seat 1', async () => {
    const seats: Seat[] = []
    const rec = await play('four', 21, undefined, 'hard', 'm', 1)
    const out = await checkAgentMoves(rec, { makeAgent: async (g, _l, seat) => { seats.push(seat); return fakeAgent(g) } })
    expect(out).toEqual({ kind: 'verified' })
    expect(seats).toEqual([0])
  })

  test("Hold'em is still held to seat 0 by the agent check", async () => {
    const rec = await play('holdem', 22)
    expect((await checkAgentMoves({ ...rec, humanSeat: 1 }, { makeAgent: async (g) => fakeAgent(g) })).kind).toBe('unverified')
  })
})

describe('a page from before sides existed (no `sides: 1` marker)', () => {
  const open = async () => (await db.select().from(schema.match)).length

  for (const game of RANDOM) {
    test(`${game}: a start without the marker is refused with a plain line, writes no row, and charges nothing`, async () => {
      for (const extra of [{}, { sides: 0 }, { sides: true }, { sides: '1' }]) {
        const r = await startMatchHandler(db, { game, level: 'hard', ...extra }, USER, { agentVersion: () => 'v1', seed: () => seedFor(game, 1) })
        expect(r.status).toBe(409)
        expect((r.body as { error: string }).error).toContain('Reload the page')
      }
      expect(await open()).toBe(0)
      expect(await ratingOf(game)).toBeUndefined()
    })

    test(`${game}: a ticket request without the marker is refused (with tickets allowed, as for a game that still had them), and a request with it is refused too: no tickets now`, async () => {
      expect((await issueTicketsHandler(db, { game, level: 'hard', count: 1 }, USER, { agentVersion: () => 'v1', noTickets: [] })).status).toBe(409)
      expect(await open()).toBe(0)
      expect((await issueTicketsHandler(db, { game, level: 'hard', sides: 1, count: 1 }, USER, { agentVersion: () => 'v1' })).status).toBe(400)
      expect(await open()).toBe(0)
    })

    test(`${game}: a start with the marker works for both seats`, async () => {
      for (const side of [0, 1] as const) {
        const m = await begin(game, seedFor(game, side))
        expect(m.humanSeat).toBe(side)
      }
    })
  }

  test('the other games need no marker', async () => {
    for (const game of ['holdem', 'fleet', 'fighter', 'arena'] as const) {
      const r = await startMatchHandler(db, { game, level: 'hard' }, USER, { agentVersion: () => 'v1', seed: () => 5 })
      expect(r.status).toBe(200)
    }
  })

  test('an old page that was refused plays a saved pre-deploy ticket (no flag, seat 0) and it settles as before, with no loss for an honest record', async () => {
    const seed = seedFor('four', 1)
    const now = Date.now()
    await db.insert(schema.match).values({
      id: 'old-ticket', game: 'four', userId: 'u-1', agentVersion: 'v1', level: 'hard', seed, status: 'ticket',
      filterFlags: { ticketIssuedAt: now, ticketExpiresAt: now + 3_600_000, ticketPlayerAllowed: true },
    })
    const rec = await play('four', seed, undefined, 'hard', 'old-ticket', 0)
    const r = body(await finishMatchHandler(db, encodeRecord(rec), USER, CHECKED))
    expect(r.valid, r.reason).toBe(true)
  })
})

describe('the who-am-I probe (count 0) on games that have no tickets', () => {
  test('is answered for every game with the viewer, writes no row, and a real request for tickets is still refused', async () => {
    for (const game of ['chess', 'four', 'holdem', 'slack', 'fighter', 'arena', 'fleet', 'word'] as const) {
      const r = await issueTicketsHandler(db, { game, level: 'easy', count: 0 }, USER, { agentVersion: () => 'v1' })
      expect(r.status, game).toBe(200)
      expect(r.body, game).toEqual({ tickets: [], viewer: { userId: 'u-1', guestId: null } })
    }
    expect(await (async () => (await db.select().from(schema.match)).length)()).toBe(0)
    expect((await issueTicketsHandler(db, { game: 'four', level: 'easy', sides: 1, count: 1 }, USER, { agentVersion: () => 'v1' })).status).toBe(400)
  })
})
