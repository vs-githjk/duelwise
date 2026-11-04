import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { replay } from '@duelwise/core/src/replay'
import { slackCore } from '@duelwise/core/src/games/slack/core'
import { NO_OFFLINE_TICKETS, RATED_NOT_OPEN } from '@duelwise/core/src/rated-path'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent } from '@duelwise/agents/src/slack/agent'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { abandonStale } from './abandon'
import { checkAgentMoves } from './agent-check'
import { isTimeCapped, makeServerAgent } from './agent-models'
import { getPath } from './path'
import { finishedResults } from './results'
import { finishMatchHandler, startMatchHandler, type FinishOptions } from './match-handlers'
import { resignMatchHandler } from './resign'
import { issueTicketsHandler } from './ticket-issue'
import { ticketGamesFor } from '../lib/tickets'
import { listTrainingMatches } from './training-export'

// Crosscurrent's rated path with the REAL opponent on the server (no stand-in): an honest match counts, a forged, edited or
// truncated one never turns into a win, leaving is a loss, and an offline ticket counts only when its moves are the opponent's own.

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
  await db.execute(sql`truncate table match, guest, rating, profile, match_report, telemetry_event`)
})

const USER = { userId: 'u-1' }
const SITE_ELO: Record<Level, number> = { easy: 700, medium: 1000, hard: 1400, champion: 1800 }
const siteElo = (_g: string, level: Level) => SITE_ELO[level]
const REAL: FinishOptions = {
  verifyAgent: (rec) => checkAgentMoves(rec, { makeAgent: (g, l, seat) => makeServerAgent(g, l, seat, null), timeCapped: isTimeCapped, budgetMs: 120_000 }),
  siteElo,
}
const level: Level = 'hard'

const ratingOf = async () => (await db.select().from(schema.rating).where(and(eq(schema.rating.userId, 'u-1'), eq(schema.rating.game, 'slack'))))[0]
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
const finish = (rec: MatchRecordV1) => finishMatchHandler(db, encodeRecord(rec), USER, REAL)

async function begin(seed = 21) {
  const r = await startMatchHandler(db, { sides: 1, game: 'slack', level }, USER, { seed: () => seed, agentVersion: () => 'v1', side: () => 0 as const })
  expect(r.status).toBe(200)
  return r.body as { matchId: string; seed: number }
}

/** The honest record of a match: a random human in seat 0, the opponent answering as the page's worker does. `forgeAt` swaps that opponent move for another legal one. */
async function played(m: { matchId: string; seed: number }, forgeAt?: number, lvl: Level = level): Promise<MatchRecordV1> {
  const ai = await createGameAgent(lvl, { seat: 1 })
  ai.reset(m.seed)
  const human = makeRng(m.seed ^ 0x77)
  let s = slackCore.init(m.seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  let moves = 0
  while (!slackCore.terminal(s)) {
    const seat = slackCore.toAct(s)[0]!
    let code: number
    if (seat === 0) {
      const legal = slackCore.legal(s, 0)
      code = slackCore.encodeAction(legal[human.int(legal.length)])
    } else {
      code = (await ai.act(slackCore.observe(s, 1)))[0]!
      if (moves === forgeAt) code = slackCore.legal(s, 1).map((a) => slackCore.encodeAction(a)).find((c) => c !== code)!
      moves++
    }
    actions.push([tick++, seat, code])
    s = slackCore.step(s, seat === 0 ? [slackCore.decodeAction(code), null] : [null, slackCore.decodeAction(code)])
  }
  const rec: MatchRecordV1 = {
    schema: 1, matchId: m.matchId, game: 'slack', coreVersion: slackCore.version, agent: { version: 'v1', level: lvl }, seed: m.seed, humanSeat: 0, actions,
    result: slackCore.result(s)!, finalHash: slackCore.hash(s), startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
  expect(replay(rec).ok).toBe(true)
  return rec
}

/** The same game claiming the human won, with the final fields to match: a legal-looking record of a match the opponent did not play. */
function claimWin(rec: MatchRecordV1): MatchRecordV1 {
  return { ...rec, result: { winner: 0, score: [40, 24], reason: 'most discs' }, finalHash: rec.finalHash }
}

describe('Crosscurrent is open for rated play', () => {
  test('Crosscurrent is not on the no-rated-path list (only Twelve Yards is), and a start that says Rated is stored as Rated', async () => {
    expect([...RATED_NOT_OPEN]).not.toContain('slack')
    const m = await begin()
    expect((await rowOf(m.matchId)).filterFlags).toEqual({ humanSeat: 0 })
  })

  test('an honest match is verified by the real server opponent, counts once, moves the rating, and is stored', async () => {
    const m = await begin()
    const rec = await played(m)
    const r = await finish(rec)
    expect(r.body).toMatchObject({ valid: true })
    expect((r.body as { elo?: unknown }).elo).toBeDefined()
    expect((await ratingOf())?.games).toBe(1)
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: true })
    expect((await finish(rec)).status).toBe(409)
    expect((await ratingOf())?.games).toBe(1)
  })
})

describe('the path card tells the truth: a rated win over Pip clears Pip, and only that', () => {
  test('an honest rated win at Easy clears the Easy stop (so "Clear Pip to unlock Marlow" is true); a loss clears nothing', async () => {
    let won = false
    for (let seed = 1; seed < 80 && !won; seed++) {
      await db.execute(sql`truncate table match, rating, profile, match_report, telemetry_event`)
      const r = await startMatchHandler(db, { sides: 1, game: 'slack', level: 'easy' }, USER, { seed: () => seed, agentVersion: () => 'v1', side: () => 0 as const })
      const m = r.body as { matchId: string; seed: number }
      const rec = await played(m, undefined, 'easy')
      const out = await finish(rec)
      expect(out.body).toMatchObject({ valid: true })
      const path = await getPath(db, USER, 'slack')
      if (rec.result.winner === 0) {
        expect(path).toEqual({ easy: true, medium: false, hard: false, champion: false })
        won = true
      } else expect(path).toEqual({ easy: false, medium: false, hard: false, champion: false })
    }
    expect(won).toBe(true)
  })
})

describe('a forged record never turns into a win', () => {
  test('the opponent plays legal blunders and the human is credited a win: refused, no path stop, no board row, not trainable', async () => {
    const m = await begin()
    // A legal game in which the "opponent" always plays its last legal cell, so the human wins it: the forger's best case.
    // The human's draws change until the blundering opponent loses, which it nearly always does.
    let s = slackCore.init(m.seed)
    let actions: MatchRecordV1['actions'] = []
    for (let salt = 0; salt < 200; salt++) {
      const human = makeRng(m.seed ^ 0x99 ^ (salt * 7919))
      s = slackCore.init(m.seed)
      actions = []
      let tick = 0
      while (!slackCore.terminal(s)) {
        const seat = slackCore.toAct(s)[0]!
        const legal = slackCore.legal(s, seat)
        const a = seat === 0 ? legal[human.int(legal.length)] : legal[legal.length - 1]
        actions.push([tick++, seat, slackCore.encodeAction(a)])
        s = slackCore.step(s, seat === 0 ? [a, null] : [null, a])
      }
      if (slackCore.result(s)!.winner === 0) break
    }
    const base = await played(m)
    const forged: MatchRecordV1 = { ...base, actions, result: slackCore.result(s)!, finalHash: slackCore.hash(s) }
    expect(replay(forged).ok).toBe(true)
    expect(forged.result.winner).toBe(0)
    const r = await finish(forged)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { reason: string }).reason).toContain('not the ones the opponent plays')
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await ratingOf()).toBeUndefined()
    expect(await getPath(db, USER, 'slack')).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(await finishedResults(db, { game: 'slack', since: new Date(0) })).toEqual([])
    expect(await listTrainingMatches(db, 'slack')).toEqual([])
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false })
  })

  test('one swapped opponent move anywhere in an honest game is refused', async () => {
    const m = await begin()
    const r = await finish(await played(m, 2))
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { reason: string }).reason).toContain('not the ones the opponent plays')
    expect(await finishedResults(db, { game: 'slack', since: new Date(0) })).toEqual([])
  })

  test('a record that claims a win it did not play is refused at the replay, whatever the opponent did', async () => {
    const m = await begin()
    const rec = await played(m)
    const r = await finish(claimWin({ ...rec, result: { winner: rec.result.winner === 0 ? 1 : 0, score: [1, 0], reason: 'x' } }))
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect(await getPath(db, USER, 'slack')).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(await finishedResults(db, { game: 'slack', since: new Date(0) })).toEqual([])
  })

  test('an edited core version is refused and gives no rating at all (an older build is not a dodge, and not a win)', async () => {
    const m = await begin()
    const rec = await played(m)
    const r = await finish({ ...rec, coreVersion: 'slack-0', result: { winner: 0, score: [64, 0], reason: 'most discs' } })
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await ratingOf()).toBeUndefined()
    expect(await finishedResults(db, { game: 'slack', since: new Date(0) })).toEqual([])
  })

  test('a dropped move (one of the human\'s placements removed) fails the replay: refused, not a win', async () => {
    const m = await begin()
    const rec = await played(m)
    const at = rec.actions.findIndex(([, seat]) => seat === 0)
    const cut = { ...rec, actions: rec.actions.filter((_, i) => i !== at) }
    const r = await finish(cut)
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await ratingOf()).toBeUndefined()
    expect(await finishedResults(db, { game: 'slack', since: new Date(0) })).toEqual([])
  })

  test('a dropped opponent move is refused too', async () => {
    const m = await begin()
    const rec = await played(m)
    const at = rec.actions.findIndex(([, seat]) => seat === 1)
    const r = await finish({ ...rec, actions: rec.actions.filter((_, i) => i !== at) })
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect(await finishedResults(db, { game: 'slack', since: new Date(0) })).toEqual([])
  })

  test('a seat flip costs the loss, like every checked game: the server holds the player to seat 0', async () => {
    const m = await begin()
    const r = await finish({ ...(await played(m)), humanSeat: 1 })
    expect((r.body as { reason: string }).reason).toContain('seat does not match the side issued')
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect(((await ratingOf())?.elo ?? 1000)).toBeLessThan(1000)
  })

  test('the wrong seed is charged as a loss, the same as a resignation', async () => {
    const control = await startMatchHandler(db, { sides: 1, game: 'slack', level }, { userId: 'u-control' }, { seed: () => 3, agentVersion: () => 'v1', side: () => 0 as const })
    expect((await resignMatchHandler(db, { matchId: (control.body as { matchId: string }).matchId, tick: 3 }, { userId: 'u-control' }, REAL)).status).toBe(200)
    const price = (await db.select().from(schema.rating).where(eq(schema.rating.userId, 'u-control')))[0]!.elo
    const m = await begin()
    const rec = await played(m)
    const r = await finish({ ...rec, seed: rec.seed + 1 })
    expect(r.body).toMatchObject({ valid: false, result: null, elo: { before: 1000, after: price } })
    expect((await ratingOf())?.elo).toBe(price)
  })
})

describe('leaving a rated match is a loss', () => {
  test('resigning costs rating, once, with the same price the other checked games charge', async () => {
    const m = await begin()
    const r = await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, USER, REAL)
    expect(r.status).toBe(200)
    expect((await ratingOf())!.elo).toBeLessThan(1000)
    expect((await ratingOf())!.games).toBe(1)
    expect((await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, USER, REAL)).status).toBe(409)
    expect((await ratingOf())!.games).toBe(1)
  })

  test('a match left open (the reload or closed tab path) is charged by the abandon sweep, once', async () => {
    const m = await begin()
    expect(await abandonStale(db, new Date(Date.now() + 24 * 3600_000), { siteElo })).toBe(1)
    expect((await ratingOf())!.elo).toBeLessThan(1000)
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'abandoned' })
    expect(await abandonStale(db, new Date(Date.now() + 48 * 3600_000), { siteElo })).toBe(0)
    expect((await ratingOf())!.games).toBe(1)
  })
})

describe('offline tickets', () => {
  // A ticket lets a player play out of the server's sight and upload only the matches they won; the owner's rule is that offline matches are
  // unrated, so Crosscurrent is kept out of tickets as Stormglass is: Rated needs a connection, Practice works offline.
  test('no ticket is issued for Crosscurrent, at any level or count', async () => {
    for (const lvl of ['easy', 'medium', 'hard', 'champion'] as const) {
      const r = await issueTicketsHandler(db, { sides: 1, game: 'slack', level: lvl, count: 1 }, USER, { agentVersion: () => 'v1', side: () => 0 as const })
      expect(r.status).toBe(400)
      expect(JSON.stringify(r.body)).toContain('no offline tickets')
    }
    expect(NO_OFFLINE_TICKETS).toContain('slack')
    expect(ticketGamesFor(RATED_NOT_OPEN)).not.toContain('slack')
    expect(ticketGamesFor(RATED_NOT_OPEN)).toEqual([])
    expect(await ratingOf()).toBeUndefined()
  })
})
