import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { makeRng } from '@duelwise/core/src/rng'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { MAX_OPEN_MATCHES, abandonStale } from './abandon'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finish } from './finish-unchecked'
import { abandonTicketsHandler, issueTicketsHandler, MAX_OPEN_TICKETS_PER_LEVEL, MAX_TICKETS_PER_HOUR, type Ticket } from './ticket-issue'
import { getGameStats } from './stats'
import { expireTickets, takeTicket, TICKET_TTL_MS } from './tickets'

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
  await db.execute(sql`truncate table match, guest, rating, profile, telemetry_event`)
  await db.execute(sql`delete from "user"`)
  await db.insert(schema.guest).values([{ id: 'g-1' }, { id: 'g-2' }])
})

const G1 = { guestId: 'g-1' }
const G2 = { guestId: 'g-2' }
const OPTS = { agentVersion: () => 'v1' }

function playFour(t: Ticket, version = 'v1'): MatchRecordV1 {
  const rng = makeRng(t.seed ^ 0x9e37)
  let s = fourCore.init(t.seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  while (!fourCore.terminal(s)) {
    const seat = fourCore.toAct(s)[0]!
    const legal = fourCore.legal(s, seat)
    const a = legal[rng.int(legal.length)]!
    actions.push([tick, seat, fourCore.encodeAction(a)])
    s = fourCore.step(s, seat === 0 ? [a, null] : [null, a])
    tick++
  }
  return {
    schema: 1, matchId: t.matchId, game: 'four', coreVersion: fourCore.version, agent: { version, level: t.level }, seed: t.seed, humanSeat: 0, actions,
    result: fourCore.result(s)!, finalHash: fourCore.hash(s), startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z',
    device: 'phone', input: 'touch', trainingAllowed: true,
  }
}

async function issue(count = 1, who = G1, game = 'four', level = 'easy', opts: Parameters<typeof issueTicketsHandler>[3] = OPTS) {
  const r = await issueTicketsHandler(db, { game, level, count }, who, opts)
  return r
}
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!

describe('ticket issue', () => {
  test('issues server ids and seeds as status ticket, tied to the agent version, expiring in 14 days', async () => {
    const now = new Date('2026-10-30T12:00:00Z')
    const r = await issue(2, G1, 'four', 'easy', { ...OPTS, now: () => now })
    expect(r.status).toBe(200)
    const tickets = (r.body as { tickets: Ticket[] }).tickets
    expect(tickets).toHaveLength(2)
    expect(new Set(tickets.map((t) => t.matchId)).size).toBe(2)
    for (const t of tickets) {
      expect(t.agentVersion).toBe('v1')
      expect(t.expiresAt).toBe(now.getTime() + TICKET_TTL_MS)
      const row = await rowOf(t.matchId)
      expect(row.status).toBe('ticket')
      expect(row.seed).toBe(t.seed)
      expect(row.guestId).toBe('g-1')
    }
  })

  test('refuses Word Duel, bad input and a missing player', async () => {
    expect((await issue(1, G1, 'word')).status).toBe(400)
    expect((await issue(1, G1, 'checkers')).status).toBe(400)
    expect((await issue(1, G1, 'four', 'godlike')).status).toBe(400)
    expect((await issue(-1)).status).toBe(400)
    expect((await issue(1, {} as never)).status).toBe(401)
  })

  test('is rate limited: a per-level pool, a per-request cap and an hourly cap', async () => {
    const first = (await issue(99)).body as { tickets: Ticket[] }
    expect(first.tickets).toHaveLength(5)
    const again = (await issue(3)).body as { tickets: Ticket[] }
    expect(again.tickets).toHaveLength(0) // pool for four/easy is full
    expect(MAX_OPEN_TICKETS_PER_LEVEL).toBe(5)
    // The hourly cap counts used tickets too, so cycling a pool cannot dodge it.
    await db.execute(sql`update match set filter_flags = filter_flags || '{"ticketUsedAt": 1}'::jsonb, status = 'finished'`)
    let issued = 5
    for (const game of ['four', 'chess', 'holdem', 'fighter', 'arena']) {
      for (const level of ['easy', 'medium', 'hard', 'champion']) {
        const b = (await issue(5, G1, game, level)).body as { tickets: Ticket[] }
        issued += b.tickets.length
        await db.execute(sql`update match set status = 'finished' where status = 'ticket'`)
      }
    }
    expect(issued).toBe(MAX_TICKETS_PER_HOUR)
  })

  test('tickets for a replaced agent version stop counting against the pool', async () => {
    await issue(5, G1, 'four', 'easy', { agentVersion: () => 'v1' })
    const r = (await issue(5, G1, 'four', 'easy', { agentVersion: () => 'v2' })).body as { tickets: Ticket[] }
    expect(r.tickets).toHaveLength(5)
    expect(r.tickets.every((t) => t.agentVersion === 'v2')).toBe(true)
    expect(await db.select().from(schema.match).where(eq(schema.match.status, 'expired'))).toHaveLength(5)
  })

  test('another player has their own pool', async () => {
    await issue(5, G1)
    expect(((await issue(5, G2)).body as { tickets: Ticket[] }).tickets).toHaveLength(5)
  })
})

describe('tickets are not matches until used', () => {
  test('the abandon sweep never scores an unused ticket, however old', async () => {
    const t = ((await issue(1)).body as { tickets: Ticket[] }).tickets[0]!
    await db.update(schema.match).set({ startedAt: new Date('2026-01-01T00:00:00Z') }).where(eq(schema.match.id, t.matchId))
    expect(await abandonStale(db, new Date('2026-10-30T00:00:00Z'))).toBe(0)
    expect((await rowOf(t.matchId)).status).toBe('ticket')
  })

  test('tickets do not count against the open match cap', async () => {
    const tickets = ((await issue(5)).body as { tickets: Ticket[] }).tickets
    for (let i = 0; i < MAX_OPEN_MATCHES + 2; i++) await startMatchHandler(db, { game: 'four', level: 'easy' }, G1, OPTS)
    for (const t of tickets) expect((await rowOf(t.matchId)).status).toBe('ticket')
  })
})

describe('uploading a ticketed match', () => {
  test('counts like an online match: replayed, finished, valid, with a match_started event', async () => {
    const t = ((await issue(1)).body as { tickets: Ticket[] }).tickets[0]!
    const rec = playFour(t)
    const r = await finish(db, encodeRecord(rec), G1, { currentAgentVersion: () => 'v1' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ valid: true, result: rec.result })
    const row = await rowOf(t.matchId)
    expect(row.status).toBe('finished')
    expect(row.recordValid).toBe(true)
    const events = await db.select().from(schema.telemetryEvent).where(eq(schema.telemetryEvent.matchId, t.matchId))
    expect(events.map((e) => e.kind).sort()).toEqual(['match_finished', 'match_started'])
  })

  test('is single use: a second upload is refused', async () => {
    const t = ((await issue(1)).body as { tickets: Ticket[] }).tickets[0]!
    const bytes = encodeRecord(playFour(t))
    expect((await finish(db, bytes, G1)).status).toBe(200)
    const again = await finish(db, bytes, G1)
    expect(again.status).toBe(409)
    // The second copy is told the first one counted.
    expect(again.body).toMatchObject({ valid: true })
  })

  test('two racing takes of one ticket start exactly one match', async () => {
    const t = ((await issue(1)).body as { tickets: Ticket[] }).tickets[0]!
    const row = await rowOf(t.matchId)
    const results = await Promise.all([takeTicket(db, row), takeTicket(db, row)])
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(results.find((x) => !x.ok)).toMatchObject({ status: 409 })
  })

  test('an expired ticket is refused with 410 and marked expired, never scored', async () => {
    const issuedAt = new Date(Date.now() - TICKET_TTL_MS - 60_000)
    const t = ((await issue(1, G1, 'four', 'easy', { ...OPTS, now: () => issuedAt })).body as { tickets: Ticket[] }).tickets[0]!
    const r = await finish(db, encodeRecord(playFour(t)), G1)
    expect(r.status).toBe(410)
    expect((await rowOf(t.matchId)).status).toBe('expired')
    expect(await db.select().from(schema.rating)).toHaveLength(0)
  })

  test('the sweep expires old unused tickets and leaves fresh ones', async () => {
    const old = ((await issue(1, G1, 'four', 'easy', { ...OPTS, now: () => new Date(Date.now() - TICKET_TTL_MS - 1000) })).body as { tickets: Ticket[] }).tickets[0]!
    const fresh = ((await issue(1, G1, 'four', 'medium')).body as { tickets: Ticket[] }).tickets[0]!
    expect(await expireTickets(db)).toBe(1)
    expect((await rowOf(old.matchId)).status).toBe('expired')
    expect((await rowOf(fresh.matchId)).status).toBe('ticket')
  })

  test('a record played against a different agent version than the ticket is not counted', async () => {
    const t = ((await issue(1)).body as { tickets: Ticket[] }).tickets[0]!
    const r = await finish(db, encodeRecord(playFour(t, 'v2')), G1)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ valid: false })
    expect((r.body as { reason: string }).reason).toContain('ticket was issued for v1')
    expect((await rowOf(t.matchId)).status).toBe('finished')
    expect((await rowOf(t.matchId)).recordValid).toBe(false)
  })

  test('a ticket issued for an agent the server has since replaced is not counted', async () => {
    const t = ((await issue(1)).body as { tickets: Ticket[] }).tickets[0]!
    const r = await finish(db, encodeRecord(playFour(t)), G1, { currentAgentVersion: () => 'v2' })
    expect(r.body).toMatchObject({ valid: false })
    expect((r.body as { reason: string }).reason).toContain('updated after this offline ticket')
  })

  test("another player cannot use someone else's ticket", async () => {
    const t = ((await issue(1)).body as { tickets: Ticket[] }).tickets[0]!
    expect((await finish(db, encodeRecord(playFour(t)), G2)).status).toBe(403)
    expect((await rowOf(t.matchId)).status).toBe('ticket')
  })
})

describe('owners, adoption and caps (review F1, F3)', () => {
  const ticketsOf = (r: Awaited<ReturnType<typeof issue>>) => (r.body as { tickets: Ticket[] }).tickets

  test('a ticket names its owner, and count 0 only answers who the player is', async () => {
    const t = ticketsOf(await issue(1))[0]!
    expect(t.owner).toEqual({ userId: null, guestId: 'g-1' })
    const who = await issue(0, { userId: 'u-1', guestId: 'g-1' } as never)
    expect(who.body).toEqual({ tickets: [], viewer: { userId: 'u-1', guestId: 'g-1' } })
    expect(await db.select().from(schema.match)).toHaveLength(1)
  })

  test('a guest ticket uploaded by the signed-in user with the same guest id counts for that user', async () => {
    await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
    const t = ticketsOf(await issue(1))[0]!
    const r = await finish(db, encodeRecord(playFour(t)), { userId: 'u-1', guestId: 'g-1' }, { currentAgentVersion: () => 'v1' })
    expect(r.status).toBe(200)
    const row = await rowOf(t.matchId)
    expect(row).toMatchObject({ status: 'finished', userId: 'u-1', guestId: null })
  })

  test("a signed-in user with another guest id still cannot use a guest's ticket", async () => {
    await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
    const t = ticketsOf(await issue(1))[0]!
    expect((await finish(db, encodeRecord(playFour(t)), { userId: 'u-1', guestId: 'g-2' })).status).toBe(403)
    expect((await rowOf(t.matchId)).status).toBe('ticket')
  })

  test('20 parallel requests for one player and level never exceed the caps', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => issue(5)))
    const issued = all.flatMap(ticketsOf)
    expect(issued.length).toBeLessThanOrEqual(MAX_OPEN_TICKETS_PER_LEVEL)
    const rows = await db.select().from(schema.match).where(eq(schema.match.status, 'ticket'))
    expect(rows).toHaveLength(issued.length)
    expect(rows.length).toBeLessThanOrEqual(MAX_OPEN_TICKETS_PER_LEVEL)
  })

  test('the caps hold even when another process commits at the same time (rows seen after the insert are given back)', async () => {
    // A second process fills the level pool between this request's first count and its re-count: the request must give back what no longer fits.
    let inserts = 0
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver)
        return (table: Parameters<Db['insert']>[0]) => ({
          values: (v: never) => ({
            then: (ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              Promise.resolve((target.insert(table) as unknown as { values(v: unknown): Promise<unknown> }).values(v))
                .then(async (r) => {
                  // After this request's last insert, the other process lands 4 more rows.
                  if (++inserts === 3) await db.insert(schema.match).values(Array.from({ length: 4 }, (_, k) => ({ id: `other-${k}`, game: 'four', userId: null, guestId: 'g-1', agentVersion: 'v1', level: 'easy', seed: k, status: 'ticket' as const, filterFlags: { ticketIssuedAt: Date.now(), ticketExpiresAt: Date.now() + 100_000 } })))
                  return r
                })
                .then(ok, bad),
          }),
        })
      },
    }) as Db
    const r = await issueTicketsHandler(racing, { game: 'four', level: 'easy', count: 3 }, G1, OPTS)
    // 3 issued plus 4 from the other process is 7; the pool holds 5, so this request keeps 1 and gives 2 back.
    const open = await db.select().from(schema.match).where(eq(schema.match.status, 'ticket'))
    expect(open).toHaveLength(MAX_OPEN_TICKETS_PER_LEVEL)
    expect(ticketsOf(r)).toHaveLength(1)
    expect(open.some((row) => row.id === ticketsOf(r)[0]!.matchId)).toBe(true)
  })
})

describe('reporting unfinished offline tickets (review F2)', () => {
  const ticketsOf = (r: Awaited<ReturnType<typeof issue>>) => (r.body as { tickets: Ticket[] }).tickets
  const user = { userId: 'u-1', guestId: 'g-1' }

  test('a signed-in player is charged a loss and the ticket becomes abandoned; a second report changes nothing', async () => {
    await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
    await db.insert(schema.rating).values({ userId: 'u-1', game: 'four', elo: 1000, games: 5 })
    const t = ticketsOf(await issue(1, user as never))[0]!
    const r = await abandonTicketsHandler(db, { matchIds: [t.matchId] }, user, { siteElo: () => 1000 })
    expect(r.body).toEqual({ settled: [t.matchId] })
    const row = await rowOf(t.matchId)
    expect(row.status).toBe('abandoned')
    const [rating] = await db.select().from(schema.rating).where(eq(schema.rating.userId, 'u-1'))
    expect(rating!.games).toBe(6)
    expect(rating!.elo).toBeLessThan(1000)
    const events = await db.select().from(schema.telemetryEvent).where(eq(schema.telemetryEvent.matchId, t.matchId))
    expect(events.map((e) => e.kind)).toEqual(['match_abandoned'])
    await abandonTicketsHandler(db, { matchIds: [t.matchId] }, user, { siteElo: () => 1000 })
    const [again] = await db.select().from(schema.rating).where(eq(schema.rating.userId, 'u-1'))
    expect(again!.games).toBe(6)
  })

  test('a used ticket is not charged, and a stranger cannot report or charge someone else', async () => {
    const t = ticketsOf(await issue(2))
    await finish(db, encodeRecord(playFour(t[0]!)), G1, { currentAgentVersion: () => 'v1' })
    const mine = await abandonTicketsHandler(db, { matchIds: [t[0]!.matchId] }, G1)
    expect(mine.body).toEqual({ settled: [t[0]!.matchId] })
    expect((await rowOf(t[0]!.matchId)).status).toBe('finished')
    const stranger = await abandonTicketsHandler(db, { matchIds: [t[1]!.matchId] }, G2)
    expect(stranger.body).toEqual({ settled: [] })
    expect((await rowOf(t[1]!.matchId)).status).toBe('ticket')
  })

  test('refuses bad input', async () => {
    expect((await abandonTicketsHandler(db, { matchIds: 'x' }, G1)).status).toBe(400)
    expect((await abandonTicketsHandler(db, { matchIds: Array(21).fill('a') }, G1)).status).toBe(400)
    expect((await abandonTicketsHandler(db, null, G1)).status).toBe(400)
  })
})

describe('stats (review F6)', () => {
  test('unused and expired tickets are not played matches', async () => {
    await issue(3)
    const s = await getGameStats(db, 'four')
    expect(s.funnel.played).toBe(0)
    expect(s.funnel.finished).toBe(0)
  })
})
