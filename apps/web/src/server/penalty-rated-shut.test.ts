import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { penaltyCore, type Zone } from '@duelwise/core/src/games/penalty/core'
import { makeRng } from '@duelwise/core/src/rng'
import { PRODUCT } from '@duelwise/core/src/product'
import { NO_OFFLINE_TICKETS, RATED_NOT_OPEN } from '@duelwise/core/src/rated-path'
import { hasRandomSide } from '@duelwise/core/src/sides'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finish } from './finish-unchecked'
import { getPath } from './path'
import { finishedResults } from './results'
import { issueTicketsHandler } from './ticket-issue'
import { TICKET_GAMES, ticketGamesFor } from '../lib/tickets'

// Twelve Yards has no rated path until its measured registry and its server check land (promotion part 2): RATED_NOT_OPEN lists it, so a start that does not
// say Practice is stored as Practice anyway, and a hand-made client cannot post an opponent that kicks badly and take a rated win, a path clear or a leaderboard
// row. The same guard is proven for any game on the list by slack-rated-shut.test.ts; this file pins the real list entry and what rides on it for Twelve Yards.

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
  await db.execute(sql`truncate table match, guest, rating, profile, "user" cascade`)
  await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
})

const USER = { userId: 'u-1' }
const startOpts = { agentVersion: () => 'v1', side: () => 0 as const }
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!

/** A whole shootout by random picks for both seats, as a record (both seats act at every tick). */
function playPenalty(matchId: string, seed: number, humanSeat: 0 | 1): MatchRecordV1 {
  const rng = makeRng(seed ^ 0x7e1e)
  let s = penaltyCore.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  while (!penaltyCore.terminal(s)) {
    const pair: [Zone, Zone] = [0, 0]
    for (const seat of penaltyCore.toAct(s)) {
      const legal = penaltyCore.legal(s, seat)
      const a = legal[rng.int(legal.length)]!
      pair[seat] = a
      actions.push([tick, seat, penaltyCore.encodeAction(a)])
    }
    s = penaltyCore.step(s, pair)
    tick++
  }
  return {
    schema: 1, matchId, game: 'penalty', coreVersion: penaltyCore.version,
    agent: { version: 'v1', level: 'easy' }, seed, humanSeat, actions,
    result: penaltyCore.result(s)!, finalHash: penaltyCore.hash(s),
    startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: false,
  }
}

describe('Twelve Yards before its rated path opens', () => {
  test('it is on the no-rated-path list, takes a random side, has no offline tickets, and is a product game', () => {
    expect([...RATED_NOT_OPEN]).toEqual(['penalty'])
    expect(hasRandomSide('penalty')).toBe(true)
    expect(NO_OFFLINE_TICKETS).toContain('penalty')
    expect(PRODUCT.games.penalty).toMatchObject({ displayName: 'Twelve Yards', slug: 'twelve-yards' })
  })

  test('a start that does not ask for Practice is stored as Practice, and so is one that asks for it, with the side the server gave', async () => {
    for (const extra of [{}, { practice: false }, { practice: true }]) {
      const r = await startMatchHandler(db, { sides: 1, game: 'penalty', level: 'easy', ...extra }, USER, startOpts)
      expect(r.status).toBe(200)
      expect((await rowOf((r.body as { matchId: string }).matchId)).filterFlags).toMatchObject({ practice: true, humanSeat: 0 })
    }
    // A page that does not say it plays any side is refused, as for every random-side game.
    const old = await startMatchHandler(db, { game: 'penalty', level: 'easy' }, USER, startOpts)
    expect(old.status).toBe(409)
  })

  test('the side is the server\'s, and a seat 1 start replays: its record is valid and unranked', async () => {
    const r = await startMatchHandler(db, { sides: 1, game: 'penalty', level: 'easy' }, USER, { agentVersion: () => 'v1', side: () => 1 as const })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    expect((await rowOf(matchId)).filterFlags).toMatchObject({ practice: true, humanSeat: 1 })
    const out = await finish(db, encodeRecord(playPenalty(matchId, seed, 1)), USER)
    expect(out.body).toMatchObject({ valid: true, unranked: true, practice: true })
  })

  test('a won record from a rated-looking start moves no rating, no path stop and no board row', async () => {
    for (let n = 1; n < 80; n++) {
      const r = await startMatchHandler(db, { sides: 1, game: 'penalty', level: 'easy' }, USER, startOpts)
      const { matchId, seed } = r.body as { matchId: string; seed: number }
      const rec = playPenalty(matchId, seed, 0)
      const out = await finish(db, encodeRecord(rec), USER)
      expect(out.body).toMatchObject({ valid: true, unranked: true, practice: true })
      expect((out.body as { elo?: unknown }).elo).toBeUndefined()
      if (rec.result.winner === 0) break
    }
    expect((await db.select().from(schema.rating)).length).toBe(0)
    expect(await getPath(db, USER, 'penalty')).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(await finishedResults(db, { game: 'penalty', since: new Date(Date.now() - 86_400_000) })).toHaveLength(0)
  })

  test('no offline tickets are issued for it, so a ticket cannot stand in for a rated start', async () => {
    const r = await issueTicketsHandler(db, { sides: 1, game: 'penalty', level: 'easy', count: 2 }, USER, startOpts)
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toMatch(/Twelve Yards has no rated matches yet/)
    expect((await db.select().from(schema.match)).length).toBe(0)
    expect(ticketGamesFor(RATED_NOT_OPEN)).not.toContain('penalty')
    expect(TICKET_GAMES).not.toContain('penalty')
  })

  test('other games are untouched: a Four start without Practice writes no flag', async () => {
    const f = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, USER, startOpts)
    expect((await rowOf((f.body as { matchId: string }).matchId)).filterFlags).toEqual({ humanSeat: 0 })
  })
})
