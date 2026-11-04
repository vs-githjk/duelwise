import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { replay } from '@duelwise/core/src/replay'
import { penaltyCore, type PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import { NO_OFFLINE_TICKETS, RATED_NOT_OPEN } from '@duelwise/core/src/rated-path'
import { isSealed } from '@duelwise/core/src/sealed'
import type { Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import { makeRng } from '@duelwise/core/src/rng'
import { penaltyAgentAction } from '@duelwise/agents/src/penalty/agent'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { abandonStale } from './abandon'
import { checkAgentMoves, SERVER_CHECKED } from './agent-check'
import { isTimeCapped, makeServerAgent } from './agent-models'
import { getPath } from './path'
import { finishedResults } from './results'
import { finishMatchHandler, startMatchHandler, type FinishOptions } from './match-handlers'
import { resignMatchHandler } from './resign'
import { PENALTY_SPEC, sealedTurnHandler, type SealedTurnBody } from './sealed-duel'
import { issueTicketsHandler } from './ticket-issue'
import { recordFromPicks } from '../games/penalty/match'
import { ticketGamesFor } from '../lib/tickets'

// Twelve Yards' rated path with the hidden choice. A counted match keeps its seed on the server: the opponent's pick for a kick is computed only after the
// player's pick for it is stored, the finished record must be exactly the server's log, and the server's own copy of the opponent re-checks every kick and dive.

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
  await db.execute(sql`truncate table match, guest, rating, profile, match_report, telemetry_event, "user" cascade`)
  await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
  await db.insert(schema.user).values({ id: 'u-2', name: 'u-2', email: 'u-2@example.test' })
})

const USER = { userId: 'u-1' }
const SITE_ELO: Record<Level, number> = { easy: 700, medium: 1000, hard: 1400, champion: 1800 }
const siteElo = (_g: string, level: Level) => SITE_ELO[level]
const REAL: FinishOptions = {
  verifyAgent: (rec) => checkAgentMoves(rec, { makeAgent: (g, l, seat) => makeServerAgent(g, l, seat, null), timeCapped: isTimeCapped, budgetMs: 120_000 }),
  siteElo,
}
const level: Level = 'medium'
const SEED = 424242

const ratingOf = async (userId = 'u-1') => (await db.select().from(schema.rating).where(and(eq(schema.rating.userId, userId), eq(schema.rating.game, 'penalty'))))[0]
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
const finish = (rec: MatchRecordV1, who = USER) => finishMatchHandler(db, encodeRecord(rec), who, REAL)
const ask = (matchId: string, actions: number[], who = USER) => sealedTurnHandler(db, { matchId, actions }, who, PENALTY_SPEC)
const bodyOf = (r: { body: unknown }) => r.body as SealedTurnBody
const storedLog = async (id: string) => (await rowOf(id)).filterFlags as { humanSeat?: number; loggedWin?: boolean; sealedLog?: { human: number[]; agent: number[] } } | null

async function begin(seed = SEED, side: Seat = 0, who = USER, lvl: Level = level) {
  const r = await startMatchHandler(db, { sides: 1, game: 'penalty', level: lvl }, who, { seed: () => seed, agentVersion: () => 'v1', side: () => side })
  expect(r.status).toBe(200)
  return r.body as { matchId: string; seed: number; sealed?: boolean; humanSeat?: Seat }
}

/** The player's next pick from their own view: a zone as shooter, a dive as keeper, drawn from the test's rng. */
function pickFor(view: PenaltyObs, rng: ReturnType<typeof makeRng>): number {
  const n = view.role === 'shooter' ? 9 : 5
  return rng.int(n)
}

/** Plays a whole counted match through the turn handler the way the page does, and builds the honest record from what the last reply revealed. */
async function playOut(m: { matchId: string }, side: Seat, who = USER, lvl: Level = level, stopAfter = Infinity) {
  const rng = makeRng(side * 977 + 5)
  const picks: number[] = []
  const views: PenaltyObs[] = []
  let view = penaltyCore.observe(penaltyCore.init(0), side)
  let last: SealedTurnBody | null = null
  while (picks.length < stopAfter) {
    picks.push(pickFor(view, rng))
    const r = await ask(m.matchId, picks, who)
    expect(r.status).toBe(200)
    last = bodyOf(r)
    view = last.view as PenaltyObs
    views.push(view)
    if (last.over) break
  }
  const reveal = last?.reveal
  if (!last?.over || !reveal) return { picks, views, last, rec: null as MatchRecordV1 | null }
  const built = recordFromPicks(reveal.seed, side, picks, reveal.agentActions)
  const rec: MatchRecordV1 = {
    schema: 1, matchId: m.matchId, game: 'penalty', coreVersion: penaltyCore.version, agent: { version: 'v1', level: lvl }, seed: reveal.seed, humanSeat: side, actions: built.actions,
    result: penaltyCore.result(built.state)!, finalHash: penaltyCore.hash(built.state),
    startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:01:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
  expect(replay(rec).ok).toBe(true)
  return { picks, views, last, rec }
}

describe('Twelve Yards is open for rated play', () => {
  test('it is on neither list that shuts rated, is server checked, and a start that says Rated is stored as Rated with the side the server gave', async () => {
    expect([...RATED_NOT_OPEN]).toEqual([])
    expect(SERVER_CHECKED).toContain('penalty')
    expect(isSealed('penalty')).toBe(true)
    expect(isTimeCapped('penalty', 'champion')).toBe(false)
    for (const side of [0, 1] as const) {
      const m = await begin(SEED + side, side)
      expect((await rowOf(m.matchId)).filterFlags).toEqual({ humanSeat: side })
      expect(m.humanSeat).toBe(side)
    }
  })

  test('a counted start sends no seed, says it is sealed, and the stored seed appears nowhere in the reply', async () => {
    const m = await begin(SEED, 1)
    expect(m).toMatchObject({ seed: 0, sealed: true, humanSeat: 1 })
    expect(JSON.stringify(m)).not.toContain(String(SEED))
    expect((await rowOf(m.matchId)).seed).toBe(SEED)
  })

  test('the server builds its copy of the opponent without any model file, for every level and both seats', async () => {
    for (const l of ['easy', 'medium', 'hard', 'champion'] as const) {
      for (const seat of [0, 1] as const) {
        const a = await makeServerAgent('penalty', l, seat, null)
        expect(a.preview).toBe(false)
        a.dispose()
      }
    }
  })
})

describe('a rated match through the hidden choice, from either side', () => {
  for (const side of [0, 1] as const) {
    test(`as seat ${side}: every kick is answered by the server, the finished record is verified by the real opponent, counts once, and moves the rating`, async () => {
      const m = await begin(SEED, side)
      const out = await playOut(m, side)
      expect(out.rec).not.toBeNull()
      // Each reply held one more finished kick than the last, and the seed and the opponent's picks came only with the last one.
      out.views.forEach((v, i) => expect(v.kicks).toHaveLength(i + 1))
      out.last!.over && expect(out.last!.reveal).toBeDefined()
      for (const [i, r] of out.views.entries()) if (i < out.views.length - 1) expect(r.over).toBe(false)
      // The server's pick for each kick is the one the agent package makes (so the server's re-check will reproduce it).
      const log = (await storedLog(m.matchId))!.sealedLog!
      let s = penaltyCore.init(SEED)
      log.agent.forEach((code, i) => {
        const agentSeat = (1 - side) as Seat
        expect(code).toBe(penaltyAgentAction(level, SEED, agentSeat, penaltyCore.observe(s, agentSeat)))
        const pair: [number, number] = [0, 0]
        pair[side] = log.human[i]!
        pair[agentSeat] = code
        s = penaltyCore.step(s, pair as never)
      })
      const r = await finish(out.rec!)
      expect(r.body).toMatchObject({ valid: true })
      expect((r.body as { elo?: unknown }).elo).toBeDefined()
      expect((await ratingOf())?.games).toBe(1)
      expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: true })
      expect((await finish(out.rec!)).status).toBe(409)
      expect((await ratingOf())?.games).toBe(1)
    })
  }

  test('a rated win clears the path stop and appears on the board; a loss clears nothing', async () => {
    let won = false
    for (let seed = 1; seed < 120 && !won; seed++) {
      await db.execute(sql`truncate table match, rating, profile, match_report, telemetry_event`)
      const side = (seed % 2) as Seat
      const m = await begin(seed, side, USER, 'easy')
      const out = await playOut(m, side, USER, 'easy')
      const r = await finish(out.rec!)
      expect(r.body).toMatchObject({ valid: true })
      const path = await getPath(db, USER, 'penalty')
      if (out.rec!.result.winner === side) {
        expect(path).toEqual({ easy: true, medium: false, hard: false, champion: false })
        expect((await finishedResults(db, { game: 'penalty', since: new Date(0) })).length).toBeGreaterThan(0)
        won = true
      } else expect(path).toEqual({ easy: false, medium: false, hard: false, champion: false })
    }
    expect(won).toBe(true)
  })
})

describe('the hidden choice: nothing about the opponent leaves the server before the player has chosen', () => {
  test('a request with no pick learns nothing, and asking for a later kick than the next one is refused', async () => {
    const m = await begin()
    expect((await ask(m.matchId, [])).status).toBe(400)
    // Two picks before the first kick has an answer: the log is empty, so the first request must carry exactly one.
    expect((await ask(m.matchId, [1, 2])).status).toBe(400)
    expect(await storedLog(m.matchId)).toEqual({ humanSeat: 0 })
    const first = await ask(m.matchId, [4])
    expect(first.status).toBe(200)
    expect((await ask(m.matchId, [4, 1, 1])).status).toBe(409)
    expect((await ask(m.matchId, [4, 99])).status).toBe(400)
  })

  test('no reply during the match holds the seed, the opponent\'s picks in a list, or the opponent\'s pick for a kick not yet played; the end holds them', async () => {
    const m = await begin(SEED, 0)
    const rng = makeRng(11)
    const picks: number[] = []
    let view = penaltyCore.observe(penaltyCore.init(0), 0)
    for (;;) {
      picks.push(pickFor(view, rng))
      const r = await ask(m.matchId, picks)
      const body = bodyOf(r)
      const text = JSON.stringify(r.body)
      view = body.view as PenaltyObs
      expect(view.kicks).toHaveLength(picks.length)
      if (body.over) {
        expect(body.reveal?.seed).toBe(SEED)
        expect(body.reveal?.agentActions).toHaveLength(picks.length)
        break
      }
      expect(body.reveal).toBeUndefined()
      expect(text).not.toContain('"seed"')
      expect(text).not.toContain('agentActions')
      expect(Object.keys(view).sort()).toEqual(['goals', 'kicks', 'over', 'role', 'round', 'seat', 'sudden', 'taken'])
    }
  })

  test('the server\'s pick for a kick does not depend on the player\'s pick for that kick, and a kick is answered only with the pick that was sent', async () => {
    // Same seed, same earlier picks, a different pick on the newest kick: the opponent's pick is the same (it is made from the kicks before it), so the
    // pick cannot be learned by trying one and seeing how the opponent answers; the choice is final once sent (next test).
    const a = await begin(SEED, 0, { userId: 'u-1' })
    const b = await begin(SEED, 0, { userId: 'u-2' })
    const ra = (bodyOf(await ask(a.matchId, [0], { userId: 'u-1' })).view as PenaltyObs).kicks[0]!
    const rb = (bodyOf(await ask(b.matchId, [8], { userId: 'u-2' })).view as PenaltyObs).kicks[0]!
    expect(ra.dive).toBe(rb.dive)
    expect(ra.zone).toBe(0)
    expect(rb.zone).toBe(8)
  })

  test('a pick cannot be changed after the opponent\'s answer: a different pick for a stored kick is refused and the stored kick stays', async () => {
    const m = await begin()
    const first = bodyOf(await ask(m.matchId, [3]))
    const again = await ask(m.matchId, [5])
    expect(again.status).toBe(409)
    expect((await storedLog(m.matchId))!.sealedLog!.human).toEqual([3])
    // Extending the stored list with a changed first pick is refused too.
    expect((await ask(m.matchId, [5, 1])).status).toBe(409)
    expect((await storedLog(m.matchId))!.sealedLog!.human).toEqual([3])
    expect(bodyOf(await ask(m.matchId, [3])).view).toEqual(first.view)
  })

  test('a retry or reconnect gets the same answer and never a second roll: the same request, resent, repeats the stored kick', async () => {
    const m = await begin()
    const one = await ask(m.matchId, [3])
    const two = await ask(m.matchId, [3])
    expect(two.body).toEqual(one.body)
    const log = (await storedLog(m.matchId))!.sealedLog!
    const three = await ask(m.matchId, [3, 2])
    const four = await ask(m.matchId, [3, 2])
    expect(four.body).toEqual(three.body)
    expect((await storedLog(m.matchId))!.sealedLog!.agent[0]).toBe(log.agent[0])
    expect((await storedLog(m.matchId))!.sealedLog!.agent).toHaveLength(2)
    // Two requests that overlap settle on one stored kick.
    const [x, y] = await Promise.all([ask(m.matchId, [3, 2, 1]), ask(m.matchId, [3, 2, 1])])
    expect(x.status).toBe(200)
    expect(y.status).toBe(200)
    expect(x.body).toEqual(y.body)
    expect((await storedLog(m.matchId))!.sealedLog!.human).toEqual([3, 2, 1])
  })

  test('starting again is a new match with its own seed: a player cannot replay a match to see the same opponent twice, and each open match is charged if left', async () => {
    const a = await begin(1111, 0)
    const b = await begin(2222, 0)
    expect(a.matchId).not.toBe(b.matchId)
    expect((await rowOf(a.matchId)).seed).not.toBe((await rowOf(b.matchId)).seed)
  })

  test('another player cannot read or extend the match', async () => {
    const m = await begin()
    expect((await ask(m.matchId, [4], { userId: 'u-2' })).status).toBe(403)
    expect((await storedLog(m.matchId))).toEqual({ humanSeat: 0 })
  })
})

/** Plays a shootout through the real core with the player's picks from `picks` (first legal pick once they run out or one is not legal) and the opponent's from `agent(state, tick)`; returns both lists and a record of it. */
function forge(base: MatchRecordV1, side: Seat, picks: number[], agent: (s: ReturnType<typeof penaltyCore.init>, tick: number) => number) {
  const agentSeat = (1 - side) as Seat
  let s = penaltyCore.init(base.seed)
  const mine: number[] = []
  const theirs: number[] = []
  const actions: MatchRecordV1['actions'] = []
  for (let tick = 0; !penaltyCore.terminal(s); tick++) {
    const legal = penaltyCore.legal(s, side) as number[]
    const a = picks[tick] !== undefined && legal.includes(picks[tick]!) ? picks[tick]! : legal[0]!
    const b = agent(s, tick)
    const pair: [number, number] = [0, 0]
    pair[side] = a
    pair[agentSeat] = b
    mine.push(a)
    theirs.push(b)
    actions.push([tick, 0, pair[0]], [tick, 1, pair[1]])
    s = penaltyCore.step(s, pair as never)
  }
  const rec: MatchRecordV1 = { ...base, actions, result: penaltyCore.result(s)!, finalHash: penaltyCore.hash(s) }
  expect(replay(rec).ok).toBe(true)
  return { rec, mine, theirs }
}

describe('the record must be the server\'s own turns, and the opponent must be the opponent', () => {
  test('a forged opponent kick (a record whose opponent played something else) is refused and the match is not counted', async () => {
    const m = await begin(SEED, 0)
    const out = await playOut(m, 0)
    const log = (await storedLog(m.matchId))!.sealedLog!
    // The forger's best case: one opponent dive changed, the rest of the game replayed so the record is legal and complete.
    const forged = forge(out.rec!, 0, out.picks, (s, tick) => {
      const real = log.agent[tick] ?? (penaltyCore.legal(s, 1)[0] as number)
      return tick === 1 ? (real + 1) % 5 : real
    })
    const r = await finish(forged.rec)
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { reason: string }).reason).toContain('record does not match the logged turns')
    expect(await getPath(db, USER, 'penalty')).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(await finishedResults(db, { game: 'penalty', since: new Date(0) })).toEqual([])
  })

  test('the server re-check refuses a log whose opponent picks are not the opponent\'s (a log written by anything but the agent), for both seats', async () => {
    for (const side of [0, 1] as const) {
      await db.execute(sql`truncate table match, rating, profile, match_report, telemetry_event`)
      const m = await begin(SEED + 5, side)
      const out = await playOut(m, side)
      const agentSeat = (1 - side) as Seat
      // Every opponent pick replaced by the first legal pick that differs from the real one, so the log and the record agree but the opponent never played them.
      const forged = forge(out.rec!, side, out.picks, (s) => {
        const real = penaltyAgentAction(level, SEED + 5, agentSeat, penaltyCore.observe(s, agentSeat))
        return (penaltyCore.legal(s, agentSeat) as number[]).find((c) => c !== real)!
      })
      await db.update(schema.match).set({ filterFlags: { humanSeat: side, sealedLog: { human: forged.mine, agent: forged.theirs } } }).where(eq(schema.match.id, m.matchId))
      const r = await finish(forged.rec)
      expect(r.body).toMatchObject({ valid: false, result: null })
      expect((r.body as { reason: string }).reason).toContain('not the ones the opponent plays')
      expect(await finishedResults(db, { game: 'penalty', since: new Date(0) })).toEqual([])
    }
  })

  test('a seat flip costs the loss: the player is held to the side the server gave', async () => {
    const m = await begin(SEED, 1)
    const out = await playOut(m, 1)
    const r = await finish({ ...out.rec!, humanSeat: 0 })
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { reason: string }).reason).toContain('seat does not match the side issued')
    expect((await ratingOf())?.elo ?? 1000).toBeLessThan(1000)
  })

  test('a finished record uploaded for a match the server has not seen finish is refused and charged as giving up, with no result stored', async () => {
    const done = await begin(SEED, 0)
    const out = await playOut(done, 0)
    await db.execute(sql`truncate table match`)
    const open = await begin(SEED, 0)
    await playOut(open, 0, USER, level, 2)
    const r = await finish({ ...out.rec!, matchId: open.matchId })
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { reason: string }).reason).toContain('record does not match the logged turns')
    expect((await ratingOf())!.games).toBe(1)
    expect((await rowOf(open.matchId)).result).toBeNull()
  })
})

describe('leaving a rated match is a loss, from either side', () => {
  for (const side of [0, 1] as const) {
    test(`resigning as seat ${side} costs rating once, even before the first kick`, async () => {
      const m = await begin(SEED, side)
      const r = await resignMatchHandler(db, { matchId: m.matchId, tick: 0 }, USER, REAL)
      expect(r.status).toBe(200)
      expect((await ratingOf())!.elo).toBeLessThan(1000)
      expect((await ratingOf())!.games).toBe(1)
      expect((await resignMatchHandler(db, { matchId: m.matchId, tick: 0 }, USER, REAL)).status).toBe(409)
      expect((await ratingOf())!.games).toBe(1)
    })
  }

  test('resigning in the middle of a match is a loss, and no further kick is accepted', async () => {
    const m = await begin(SEED, 1)
    await playOut(m, 1, USER, level, 2)
    const r = await resignMatchHandler(db, { matchId: m.matchId, tick: 2 }, USER, REAL)
    expect(r.status).toBe(200)
    expect((await ratingOf())!.games).toBe(1)
    expect((await ask(m.matchId, [1, 2, 3])).status).toBe(409)
    // The settled row keeps its log and the seat the log belongs to, so it still reads the same.
    expect(await storedLog(m.matchId)).toMatchObject({ humanSeat: 1, sealedLog: { human: expect.any(Array), agent: expect.any(Array) } })
  })

  test('an abandoned row keeps its log and seat too', async () => {
    const m = await begin(SEED, 1)
    await playOut(m, 1, USER, level, 2)
    expect(await abandonStale(db, new Date(Date.now() + 24 * 3600_000), { siteElo })).toBe(1)
    expect(await storedLog(m.matchId)).toMatchObject({ humanSeat: 1, abandoned: true, sealedLog: { human: expect.any(Array) } })
  })

  test('a match left open (closed tab, reload) is charged by the abandon sweep, once, with or without kicks', async () => {
    const empty = await begin(SEED, 0)
    const part = await begin(SEED + 1, 1)
    await playOut(part, 1, USER, level, 2)
    expect(await abandonStale(db, new Date(Date.now() + 24 * 3600_000), { siteElo })).toBe(2)
    expect((await ratingOf())!.games).toBe(2)
    expect((await ratingOf())!.elo).toBeLessThan(1000)
    expect(await rowOf(empty.matchId)).toMatchObject({ status: 'abandoned' })
    expect(await rowOf(part.matchId)).toMatchObject({ status: 'abandoned' })
    expect(await abandonStale(db, new Date(Date.now() + 48 * 3600_000), { siteElo })).toBe(0)
    expect((await ratingOf())!.games).toBe(2)
  })

  test('when the server\'s own log already says the player won, giving up costs nothing (no gain, no charge), from either side', async () => {
    let tried = 0
    for (let seed = 1; seed < 150 && tried < 2; seed++) {
      const side = (tried % 2) as Seat
      await db.execute(sql`truncate table match, rating, profile, match_report, telemetry_event`)
      const m = await begin(seed, side, USER, 'easy')
      const out = await playOut(m, side, USER, 'easy')
      if (out.rec!.result.winner !== side) continue
      tried++
      expect((await storedLog(m.matchId))!.loggedWin).toBe(true)
      const r = await resignMatchHandler(db, { matchId: m.matchId, tick: 9 }, USER, REAL)
      expect(r.body).toMatchObject({ resigned: true, loggedWin: true })
      expect(await ratingOf()).toBeUndefined()
    }
    expect(tried).toBe(2)
  })

  test('a lost match the player never uploaded is charged when it is given up (the log says the agent won)', async () => {
    for (let seed = 1; seed < 150; seed++) {
      await db.execute(sql`truncate table match, rating, profile, match_report, telemetry_event`)
      const m = await begin(seed, 0, USER, 'hard')
      const out = await playOut(m, 0, USER, 'hard')
      if (out.rec!.result.winner === 0) continue
      const r = await resignMatchHandler(db, { matchId: m.matchId, tick: 9 }, USER, REAL)
      expect(r.body).toMatchObject({ resigned: true })
      expect((await ratingOf())!.games).toBe(1)
      return
    }
    throw new Error('no lost match found')
  })
})

describe('offline and other games', () => {
  test('no offline ticket is issued for Twelve Yards: Rated needs a connection', async () => {
    const r = await issueTicketsHandler(db, { sides: 1, game: 'penalty', level: 'easy', count: 2 }, USER, { agentVersion: () => 'v1', side: () => 0 as const })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('no offline tickets')
    expect(NO_OFFLINE_TICKETS).toContain('penalty')
    expect(ticketGamesFor(RATED_NOT_OPEN)).not.toContain('penalty')
    expect((await db.select().from(schema.match)).length).toBe(0)
  })

  test('other games start as before: Four and chess send their seed and side, Stormglass stays sealed with no side, and none writes a log flag', async () => {
    for (const game of ['four', 'chess'] as const) {
      const r = await startMatchHandler(db, { sides: 1, game, level: 'easy' }, USER, { seed: () => 77, agentVersion: () => 'v1', side: () => 1 as const })
      expect(r.body).toMatchObject({ seed: 77, humanSeat: 1 })
      expect((r.body as { sealed?: boolean }).sealed).toBeUndefined()
      expect((await rowOf((r.body as { matchId: string }).matchId)).filterFlags).toEqual({ humanSeat: 1 })
    }
    const f = await startMatchHandler(db, { game: 'fleet', level: 'easy' }, USER, { seed: () => 77, agentVersion: () => 'v1' })
    expect(f.body).toMatchObject({ seed: 0, sealed: true })
    expect((f.body as { humanSeat?: unknown }).humanSeat).toBeUndefined()
  })
})
