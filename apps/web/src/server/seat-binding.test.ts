import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { replay } from '@duelwise/core/src/replay'
import type { Seat } from '@duelwise/core/src/types'
import { playRealtime } from '../report/testing'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { checkAgentMoves } from './agent-check'
import { fakeAgent, play } from './agent-check-fixtures'
import { getLevelBoard } from './board'
import { getBoard } from './landing'
import { getLeaderboard, MIN_GAMES } from './leaderboard'
import { finishMatchHandler, startMatchHandler, type Caller, type FinishBody, type FinishOptions } from './match-handlers'
import { getPath } from './path'
import { issueTicketsHandler, type Ticket } from './ticket-issue'
import { TICKET_TTL_MS } from './tickets'
import { wordMarksHandler, type WordMarksBody } from './word-marks'

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
const GUEST: Caller = { guestId: 'g-1' }
const NOW = () => new Date()

/** The production shape of the agent check, with the fake opponent standing in for the shipped one. */
const CHECKED: FinishOptions = { verifyAgent: (rec) => checkAgentMoves(rec, { makeAgent: async (g) => fakeAgent(g) }) }

const body = (r: { body: unknown }) => r.body as FinishBody
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
const ratingOf = async (game: GameId) => (await db.select().from(schema.rating).where(and(eq(schema.rating.userId, 'u-1'), eq(schema.rating.game, game))))[0]

async function begin(game: GameId, level: Level, who: Caller, seed: number, extra: Record<string, unknown> = {}) {
  const r = await startMatchHandler(db, { game, level, ...extra }, who, { agentVersion: () => 'v1', seed: () => seed, side: () => 0 as const })
  expect(r.status).toBe(200)
  return r.body as { matchId: string }
}

/** Everything a win shows up in for this player. Each stays empty for a record that is not a win. */
async function standing(game: GameId, level: Level, who: Caller) {
  const board = await getLevelBoard(db, game, who, new Set(), NOW())
  const landing = await getBoard(db, NOW())
  const events = await db.select().from(schema.telemetryEvent).where(eq(schema.telemetryEvent.kind, 'match_finished'))
  return {
    cleared: (await getPath(db, who, game))[level],
    boardWins: board.columns.find((c) => c.level === level)!.me?.wins ?? 0,
    landingWins: landing.humanWins,
    outcomes: events.map((e) => e.outcome),
  }
}
const NOT_A_WIN = { cleared: false, boardWins: 0, landingWins: 0, outcomes: [null] }

const WORDS = ['crane', 'slate', 'house', 'pilot', 'mound', 'fjord', 'vivid']

/** Plays a real sealed match through the marks endpoint with words that miss, or `hit` at the given round (from 0). */
async function playWord(who: Caller, seed: number, level: Level = 'champion', extra: Record<string, unknown> = {}, hit?: number) {
  const { matchId } = await begin('word', level, who, seed, extra)
  const answer = wordCore.init(seed).answer
  const wrong = WORDS.filter((w) => w !== answer)
  const mine: string[] = []
  for (let i = 0; i < 6; i++) {
    mine.push(i === hit ? answer : wrong[i]!)
    const reply = await wordMarksHandler(db, { matchId, guesses: [...mine] }, who)
    expect(reply.status).toBe(200)
    const b = reply.body as WordMarksBody
    if (b.over) {
      const guesses: [string[], string[]] = [mine, b.reveal!.agentGuesses]
      return { matchId, seed: b.reveal!.seed, level, guesses, winner: wordOf(matchId, b.reveal!.seed, guesses, level).result.winner }
    }
  }
  throw new Error('the match did not end')
}

/** The record the page builds from the marked rounds, with `guesses[0]` in seat 0 and `guesses[1]` in seat 1. */
function wordOf(matchId: string, seed: number, guesses: [string[], string[]], level: Level, humanSeat: Seat = 0): MatchRecordV1 {
  let st = wordCore.init(seed)
  const actions: MatchRecordV1['actions'] = []
  guesses[0].forEach((w, t) => {
    actions.push([t, 0, wordCore.encodeAction(w)], [t, 1, wordCore.encodeAction(guesses[1][t]!)])
    st = wordCore.step(st, [w, guesses[1][t]!])
  })
  return {
    schema: 1, matchId, game: 'word', coreVersion: wordCore.version, agent: { version: 'v1', level }, seed, humanSeat, actions,
    result: wordCore.result(st)!, finalHash: wordCore.hash(st), trainingAllowed: true,
    startedAt: '2026-11-02T10:00:00.000Z', endedAt: '2026-11-02T10:01:00.000Z', device: 'desktop', input: 'keyboard',
  }
}
const wordBytes = (m: Awaited<ReturnType<typeof playWord>>, humanSeat: Seat = 0) => encodeRecord(wordOf(m.matchId, m.seed, m.guesses, m.level, humanSeat))

/** The first Champion match from seed `from` on that the player really loses. */
async function lostWord(who: Caller, from = 100) {
  for (let seed = from; ; seed++) {
    const m = await playWord(who, seed)
    if (m.winner === 1) return m
  }
}

describe('Word Duel: the player is seat 0', () => {
  test('eight lost Champion matches uploaded from seat 1 are invalid and each costs the loss', async () => {
    const out: Array<boolean> = []
    const elos: number[] = [1000]
    let from = 100
    for (let i = 0; i < 8; i++) {
      const m = await lostWord(USER, from)
      from = m.seed + 1
      const r = await finishMatchHandler(db, wordBytes(m, 1), USER)
      expect(r.status).toBe(200)
      out.push(body(r).valid)
      expect(body(r).elo!.before).toBe(elos.at(-1)!)
      expect(body(r).elo!.after).toBeLessThan(elos.at(-1)!)
      elos.push(body(r).elo!.after)
    }
    expect<unknown>({ valid: out, rating: await ratingOf('word') }).toMatchObject({ valid: Array(8).fill(false), rating: { elo: elos.at(-1)!, games: 8 } })
  })

  test('a seat 1 record says why, stores nothing, and shows as a win nowhere', async () => {
    const m = await lostWord(USER)
    const r = await finishMatchHandler(db, wordBytes(m, 1), USER)
    expect(r.body).toMatchObject({ valid: false, reason: 'a sealed match is played from seat 0', result: null, elo: { before: 1000 } })
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false, invalidReason: 'a sealed match is played from seat 0' })
    expect((await ratingOf('word'))!.elo).toBeLessThan(1000)
    expect(await standing('word', 'champion', USER)).toEqual({ ...NOT_A_WIN })
  })

  test('a player already on the leaderboard falls on it with a seat 1 record', async () => {
    await db.insert(schema.rating).values({ userId: 'u-1', game: 'word', elo: 1000, games: MIN_GAMES })
    const m = await lostWord(USER)
    await finishMatchHandler(db, wordBytes(m, 1), USER)
    const [entry] = await getLeaderboard(db, 'word')
    expect(entry).toMatchObject({ rank: 1, name: 'Rival', games: MIN_GAMES + 1 })
    expect(entry!.elo).toBeLessThan(1000)
  })

  test('a seat 1 record of a match the player won is refused the same way, and costs the same loss', async () => {
    const m = await playWord(USER, 500, 'easy', {}, 0)
    expect(m.winner).toBe(0)
    expect(body(await finishMatchHandler(db, wordBytes(m, 1), USER))).toMatchObject({ valid: false, reason: 'a sealed match is played from seat 0' })
    expect((await ratingOf('word'))!.elo).toBeLessThan(1000)
  })

  test("a lost match uploaded with the seats' words swapped is refused by the marked rounds", async () => {
    const m = await lostWord(USER)
    const swapped = wordOf(m.matchId, m.seed, [m.guesses[1], m.guesses[0]], m.level)
    expect(swapped.result.winner).toBe(0)
    expect(replay(swapped).ok).toBe(true)
    expect(body(await finishMatchHandler(db, encodeRecord(swapped), USER))).toMatchObject({ valid: false, reason: 'record does not match the marked rounds' })
    expect(await ratingOf('word')).toBeUndefined()
  })

  test('an honest seat 0 win counts: rating up, on the path, on the boards', async () => {
    const m = await playWord(USER, 500, 'easy', {}, 0)
    expect(m.winner).toBe(0)
    const r = body(await finishMatchHandler(db, wordBytes(m), USER))
    expect(r).toMatchObject({ valid: true, result: { winner: 0 } })
    expect(r.elo!.after).toBeGreaterThan(r.elo!.before)
    expect(await rowOf(m.matchId)).toMatchObject({ recordValid: true, trainingAllowed: true, invalidReason: null })
    expect(await standing('word', 'easy', USER)).toEqual({ cleared: true, boardWins: 1, landingWins: 1, outcomes: ['human'] })
  })

  test('an honest seat 0 loss counts as a loss: rating down, no clear', async () => {
    const m = await lostWord(USER)
    const r = body(await finishMatchHandler(db, wordBytes(m), USER))
    expect(r).toMatchObject({ valid: true, result: { winner: 1 } })
    expect(r.elo!.after).toBeLessThan(r.elo!.before)
    expect(await standing('word', 'champion', USER)).toEqual({ cleared: false, boardWins: 0, landingWins: 0, outcomes: ['ai'] })
  })

  test('an honest guest win and loss behave as before: valid, no rating, the win clears the level', async () => {
    const win = await playWord(GUEST, 500, 'easy', {}, 0)
    const won = body(await finishMatchHandler(db, wordBytes(win), GUEST))
    expect(won).toEqual({ valid: true, result: wordOf(win.matchId, win.seed, win.guesses, 'easy').result })
    const lost = await lostWord(GUEST)
    const gone = body(await finishMatchHandler(db, wordBytes(lost), GUEST))
    expect(gone).toMatchObject({ valid: true, result: { winner: 1 } })
    expect(gone.elo).toBeUndefined()
    expect(await standing('word', 'easy', GUEST)).toMatchObject({ cleared: true, boardWins: 1 })
    expect((await standing('word', 'champion', GUEST)).cleared).toBe(false)
  })

  test('a guest seat 1 record is invalid and clears nothing', async () => {
    const m = await lostWord(GUEST)
    expect(body(await finishMatchHandler(db, wordBytes(m, 1), GUEST))).toMatchObject({ valid: false, reason: 'a sealed match is played from seat 0' })
    expect(await standing('word', 'champion', GUEST)).toEqual({ ...NOT_A_WIN })
  })

  test('practice stays practice, and a seat 1 practice record is refused too', async () => {
    const honest = await playWord(USER, 500, 'easy', { practice: true }, 0)
    expect(body(await finishMatchHandler(db, wordBytes(honest), USER))).toMatchObject({ valid: true, practice: true, unranked: true })
    const flipped = await playWord(USER, 501, 'easy', { practice: true }, 0)
    expect(body(await finishMatchHandler(db, wordBytes(flipped, 1), USER))).toMatchObject({ valid: false })
    expect(await ratingOf('word')).toBeUndefined()
  })

  test('offline Word stays as it was: no ticket is issued, and a ticket row with no marked rounds is refused for that reason', async () => {
    expect((await issueTicketsHandler(db, { game: 'word', level: 'easy', count: 1 }, USER)).status).toBe(400)
    const now = Date.now()
    await db.insert(schema.match).values({
      id: 'ticket-word', game: 'word', userId: 'u-1', agentVersion: 'v1', level: 'easy', seed: 500, status: 'ticket',
      filterFlags: { ticketIssuedAt: now, ticketExpiresAt: now + TICKET_TTL_MS, ticketPlayerAllowed: true },
    })
    const answer = wordCore.init(500).answer
    const r = await finishMatchHandler(db, encodeRecord(wordOf('ticket-word', 500, [[answer], ['crane']], 'easy')), USER)
    expect(body(r)).toMatchObject({ valid: false, reason: 'record does not match the marked rounds' })
    expect(await ratingOf('word')).toBeUndefined()
  })
})

// Seeds with a known outcome from playRealtime: seat 0 wins `win`, seat 1 wins `loss`.
for (const [game, seeds] of [['fighter', { win: 1, loss: 2 }], ['arena', { win: 3, loss: 1 }]] as const) {
  describe(`${game}: the player is seat 0`, () => {
    const recordOf = (seed: number, matchId: string, humanSeat: Seat = 0) => encodeRecord({ ...playRealtime(game, seed, humanSeat, 'hard'), matchId })

    test('a lost match uploaded from seat 1 is invalid and shows as a win nowhere', async () => {
      for (const who of [USER, GUEST]) {
        await db.execute(sql`truncate table telemetry_event`)
        const { matchId } = await begin(game, 'hard', who, seeds.loss)
        const r = await finishMatchHandler(db, recordOf(seeds.loss, matchId, 1), who)
        expect(r.body).toEqual({ valid: false, reason: 'a real-time match is played from seat 0', result: null })
        expect(await rowOf(matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false })
        expect(await standing(game, 'hard', who)).toEqual({ ...NOT_A_WIN })
      }
      expect(await ratingOf(game)).toBeUndefined()
    })

    test('an honest seat 0 win counts on the path and the boards and stays unranked', async () => {
      for (const who of [USER, GUEST]) {
        await db.execute(sql`truncate table match, telemetry_event`)
        const { matchId } = await begin(game, 'hard', who, seeds.win)
        expect(body(await finishMatchHandler(db, recordOf(seeds.win, matchId), who))).toMatchObject({ valid: true, unranked: true, result: { winner: 0 } })
        expect(await standing(game, 'hard', who)).toEqual({ cleared: true, boardWins: 1, landingWins: 1, outcomes: ['human'] })
      }
    })

    test('an honest seat 0 loss is a valid loss', async () => {
      for (const who of [USER, GUEST]) {
        await db.execute(sql`truncate table match, telemetry_event`)
        const { matchId } = await begin(game, 'hard', who, seeds.loss)
        expect(body(await finishMatchHandler(db, recordOf(seeds.loss, matchId), who))).toMatchObject({ valid: true, unranked: true, result: { winner: 1 } })
        expect(await standing(game, 'hard', who)).toEqual({ cleared: false, boardWins: 0, landingWins: 0, outcomes: ['ai'] })
      }
    })

    test('an offline ticket is honest from seat 0 and refused from seat 1', async () => {
      const issued = await issueTicketsHandler(db, { game, level: 'hard', count: 2 }, USER, { agentVersion: () => 'v1', seed: () => seeds.win })
      const [good, bad] = (issued.body as { tickets: Ticket[] }).tickets
      expect(body(await finishMatchHandler(db, recordOf(seeds.win, good!.matchId), USER))).toMatchObject({ valid: true, unranked: true })
      expect(body(await finishMatchHandler(db, recordOf(seeds.win, bad!.matchId, 1), USER))).toMatchObject({ valid: false, reason: 'a real-time match is played from seat 0' })
      expect(await rowOf(bad!.matchId)).toMatchObject({ status: 'finished', recordValid: false })
    })
  })
}

// Seeds with a known outcome against the fake agent in seat 1 (agent-check-fixtures play()).
for (const [game, seeds] of [['chess', { win: 11, loss: 4 }], ['four', { win: 1, loss: 2 }], ['holdem', { win: 1, loss: 3 }]] as const) {
  describe(`${game}: the agent check binds the player to seat 0`, () => {
    const lost = async (matchId: string) => {
      const rec = await play(game, seeds.loss, undefined, 'hard', matchId)
      expect(rec.result.winner).toBe(1)
      return rec
    }

    test('a lost match uploaded from seat 1 is invalid: the loss is charged, no stored bytes, no win', async () => {
      const { matchId } = await begin(game, 'hard', USER, seeds.loss)
      const r = await finishMatchHandler(db, encodeRecord({ ...(await lost(matchId)), humanSeat: 1 }), USER, CHECKED)
      expect(body(r).valid).toBe(false)
      expect(body(r).reason).toContain(game === 'holdem' ? 'only a human in seat 0 can be checked' : 'seat does not match the side issued')
      expect(await rowOf(matchId)).toMatchObject({ recordValid: false, record: null, trainingAllowed: false })
      expect((await ratingOf(game))!.elo).toBeLessThan(1000)
      expect(await standing(game, 'hard', USER)).toEqual({ ...NOT_A_WIN })
    })

    test("a guest's seat 1 record is withdrawn by the check that runs after the answer", async () => {
      const { matchId } = await begin(game, 'hard', GUEST, seeds.loss)
      const pending: Promise<unknown>[] = []
      await finishMatchHandler(db, encodeRecord({ ...(await lost(matchId)), humanSeat: 1 }), GUEST, { ...CHECKED, deferCheck: (p) => pending.push(p) })
      await Promise.all(pending)
      expect(await rowOf(matchId)).toMatchObject({ recordValid: false, record: null, trainingAllowed: false })
      expect(await standing(game, 'hard', GUEST)).toEqual({ ...NOT_A_WIN })
    })

    test('with no check configured the seat 1 record does not count either', async () => {
      const { matchId } = await begin(game, 'hard', USER, seeds.loss)
      expect(body(await finishMatchHandler(db, encodeRecord({ ...(await lost(matchId)), humanSeat: 1 }), USER))).toMatchObject({ valid: false })
      expect((await ratingOf(game))!.elo).toBeLessThan(1000)
    })

    test('a lost match with the seat of every action swapped is invalid', async () => {
      const { matchId } = await begin(game, 'hard', USER, seeds.loss)
      const rec = await lost(matchId)
      const swapped = rec.actions.map(([t, s, a]) => [t, (1 - s) as Seat, a]) as MatchRecordV1['actions']
      expect(body(await finishMatchHandler(db, encodeRecord({ ...rec, actions: swapped }), USER, CHECKED))).toMatchObject({ valid: false })
      expect(await ratingOf(game)).toBeUndefined()
    })

    test('an honest seat 0 win and loss still count', async () => {
      const a = await begin(game, 'hard', USER, seeds.win)
      const won = await play(game, seeds.win, undefined, 'hard', a.matchId)
      expect(won.result.winner).toBe(0)
      const up = body(await finishMatchHandler(db, encodeRecord(won), USER, CHECKED))
      expect(up).toMatchObject({ valid: true, result: { winner: 0 } })
      expect(up.elo!.after).toBeGreaterThan(up.elo!.before)
      const b = await begin(game, 'hard', USER, seeds.loss)
      const down = body(await finishMatchHandler(db, encodeRecord(await lost(b.matchId)), USER, CHECKED))
      expect(down).toMatchObject({ valid: true, result: { winner: 1 } })
      expect(down.elo!.after).toBeLessThan(down.elo!.before)
    })
  })
}

describe('no real client plays from another seat', () => {
  // The seat checks above refuse any record not from seat 0, so a page that ever sent another seat would lose every match it plays.
  const HOOKS = {
    chess: { hook: 'chess/useChessMatch.ts', seat: 'chess/useChessMatch.ts' },
    four: { hook: 'four/useFourMatch.ts', seat: 'four/useFourMatch.ts' },
    holdem: { hook: 'holdem/useHoldemMatch.ts', seat: 'holdem/seats.ts' },
    word: { hook: 'word/useWordMatch.ts', seat: 'word/useWordMatch.ts' },
    fighter: { hook: 'fighter/useFighterMatch.ts', seat: 'fighter/useFighterMatch.ts' },
    arena: { hook: 'arena/useArenaMatch.ts', seat: 'arena/useArenaMatch.ts' },
    fleet: { hook: 'fleet/useFleetMatch.ts', seat: 'fleet/useFleetMatch.ts' },
  }
  const source = (path: string) => readFileSync(new URL(`../games/${path}`, import.meta.url), 'utf8')

  // Chess, Four in a Row and Crosscurrent give the player a random side (core/sides.ts): their pages record the seat the session carries, which the server issued.
  const RANDOM_SIDE = ['chess', 'four']
  for (const [game, { hook, seat }] of Object.entries(HOOKS)) {
    if (RANDOM_SIDE.includes(game)) continue
    test(`${game} records the fixed seat 0`, () => {
      expect(source(seat)).toMatch(/\bconst HUMAN: Seat = 0\b/)
      expect(source(hook).match(/^\s+humanSeat: .+$/gm)?.map((l) => l.trim())).toEqual(['humanSeat: HUMAN,'])
    })
  }
  for (const game of RANDOM_SIDE) {
    const hook = game === 'slack' ? 'slack/useSlackMatch.ts' : HOOKS[game as 'chess' | 'four'].hook
    test(`${game} records the seat of the session the server issued, never a constant`, () => {
      expect(source(hook)).toMatch(/const mineSeat = opened\.session\.humanSeat\b/)
      expect(source(hook).match(/^\s+humanSeat: .+,$/gm)?.map((l) => l.trim())).toEqual(['humanSeat: mineSeat,'])
    })
  }

  test('the upload checks and the resign and abandon paths agree', () => {
    for (const file of ['./resign.ts', './abandon.ts']) expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toMatch(/humanSeat: 0\b/)
  })
})
