import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { slackCore } from '@duelwise/core/src/games/slack/core'
import { makeRng } from '@duelwise/core/src/rng'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finish } from './finish-unchecked'
import { getPath } from './path'
import { finishedResults } from './results'
import { RATED_NOT_OPEN } from '@duelwise/core/src/rated-path'
import type { GameId } from '@duelwise/core/src/product'
import { issueTicketsHandler } from './ticket-issue'
import { TICKET_GAMES, ticketGamesFor } from '../lib/tickets'

// A game with no rated path (one listed in RATED_NOT_OPEN, because the server cannot re-run its opponent) must have a start that does not say Practice
// stored as Practice anyway, so a hand-made client cannot post an opponent that plays badly and take a rated win, a path clear or a leaderboard row.
// Crosscurrent was the game on that list until its opponent joined the server-checked games; the guard is kept and proven here by putting it on the
// list for the length of each test, so the mechanism stays pinned for the next game that ships before its check does.

type Db = PgliteDatabase<typeof schema>
let client: PGlite
let db: Db

beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
const listed = RATED_NOT_OPEN as GameId[]
/** What the list holds for real (Twelve Yards until its rated path opens); each test adds Crosscurrent and the list goes back to this after it. */
const real = [...RATED_NOT_OPEN]
beforeEach(async () => {
  listed.push('slack')
  await db.execute(sql`truncate table match, guest, rating, profile, "user" cascade`)
  await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
})

const USER = { userId: 'u-1' }
const startOpts = { agentVersion: () => 'v1', side: () => 0 as const }
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!

/** A whole Crosscurrent game by random legal moves for both seats, as a record. */
function playSlack(matchId: string, seed: number): MatchRecordV1 {
  const rng = makeRng(seed ^ 0x51ac)
  let s = slackCore.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  while (!slackCore.terminal(s)) {
    const seat = slackCore.toAct(s)[0]!
    const legal = slackCore.legal(s, seat)
    const a = legal[rng.int(legal.length)]!
    actions.push([tick++, seat, slackCore.encodeAction(a)])
    s = slackCore.step(s, seat === 0 ? [a, null] : [null, a])
  }
  return {
    schema: 1, matchId, game: 'slack', coreVersion: slackCore.version,
    agent: { version: 'v1', level: 'easy' }, seed, humanSeat: 0, actions,
    result: slackCore.result(s)!, finalHash: slackCore.hash(s),
    startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: false,
  }
}

afterEach(() => {
  listed.length = 0
  listed.push(...real)
})

describe('a game with no rated path yet (Crosscurrent, listed for these tests)', () => {
  test('the list holds the game for the length of a test and is as it was after it', () => {
    expect([...RATED_NOT_OPEN]).toEqual([...real, 'slack'])
  })

  test('a start that does not ask for Practice is stored as Practice, and so is one that asks for it', async () => {
    for (const extra of [{}, { practice: false }, { practice: true }]) {
      const r = await startMatchHandler(db, { sides: 1, game: 'slack', level: 'easy', ...extra }, USER, startOpts)
      expect(r.status).toBe(200)
      expect((await rowOf((r.body as { matchId: string }).matchId)).filterFlags).toMatchObject({ practice: true })
    }
  })

  test('a won record from a rated-looking start moves no rating, no path stop and no board row', async () => {
    // Find a seed for which random play ends in a human win, so only the Practice marker can keep it off a competitive read.
    for (let n = 1; n < 60; n++) {
      const r = await startMatchHandler(db, { sides: 1, game: 'slack', level: 'easy' }, USER, startOpts)
      const { matchId, seed } = r.body as { matchId: string; seed: number }
      const rec = playSlack(matchId, seed)
      const out = await finish(db, encodeRecord(rec), USER)
      expect(out.body).toMatchObject({ valid: true, unranked: true, practice: true })
      expect((out.body as { elo?: unknown }).elo).toBeUndefined()
      if (rec.result.winner === 0) {
        await db.update(schema.match).set({ result: rec.result }).where(eq(schema.match.id, matchId))
        break
      }
    }
    expect((await db.select().from(schema.rating)).length).toBe(0)
    expect(await getPath(db, USER, 'slack')).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(await finishedResults(db, { game: 'slack', since: new Date(Date.now() - 86_400_000) })).toHaveLength(0)
  })

  test('no offline tickets are issued for it, so a ticket cannot stand in for a rated start', async () => {
    const r = await issueTicketsHandler(db, { sides: 1, game: 'slack', level: 'easy', count: 2 }, USER, startOpts)
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toMatch(/Crosscurrent has no rated matches yet/)
    expect((await db.select().from(schema.match)).length).toBe(0)
    // The live list leaves Crosscurrent out whether or not its rated path is shut: tickets are refused for it either way.
    expect(ticketGamesFor(RATED_NOT_OPEN)).not.toContain('slack')
    // Offline matches are unrated in every game (decisions.md, Nov 3 16:23): no game has tickets.
    expect(ticketGamesFor(RATED_NOT_OPEN)).toEqual([])
    expect(TICKET_GAMES).not.toContain('slack')
    // Word and Stormglass keep their own refusal.
    expect((await issueTicketsHandler(db, { sides: 1, game: 'fleet', level: 'easy', count: 1 }, USER, startOpts)).status).toBe(400)
    for (const g of ['chess', 'four', 'holdem', 'fighter', 'arena'] as const) expect((await issueTicketsHandler(db, { sides: 1, game: g, level: 'easy', count: 1 }, USER, startOpts)).status).toBe(400)
  })

  test('other games are untouched: a Four start without Practice writes no flag', async () => {
    const f = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, USER, startOpts)
    expect((await rowOf((f.body as { matchId: string }).matchId)).filterFlags).toEqual({ humanSeat: 0 })
  })
})
