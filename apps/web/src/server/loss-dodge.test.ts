import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import { fleetCore, shipCells, type Placement } from '@duelwise/core/src/games/fleet'
import { wordCore } from '@duelwise/core/src/games/word/core'
import type { GameId, Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { abandonStale } from './abandon'
import { checkAgentMoves } from './agent-check'
import { fakeAgent, play } from './agent-check-fixtures'
import { finishMatchHandler, startMatchHandler, type FinishOptions } from './match-handlers'
import { getUserRating } from './leaderboard'
import { getPath } from './path'
import { getMyRecord } from './landing'
import { getCardFacts, getReport } from './report'
import { getGameStats } from './stats'
import { resignMatchHandler } from './resign'
import { finishedResults } from './results'
import { FLEET_SPEC, sealedTurnHandler, type SealedSpec, type SealedTurnBody } from './sealed-duel'
import { issueTicketsHandler, type Ticket } from './ticket-issue'
import { listTrainingMatches } from './training-export'
import { wordMarksHandler, type WordMarksBody } from './word-marks'
import { recordFromLists, shotCode } from '../games/fleet/useFleetMatch'

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
const OTHER = { userId: 'u-2' }
const CONTROL = { userId: 'u-control' }
const GUEST = { guestId: 'g-1' }
const SITE_ELO: Record<Level, number> = { easy: 700, medium: 1000, hard: 1400, champion: 1800 }
const siteElo = (_game: GameId, level: Level) => SITE_ELO[level]
/** The production shape of the finish options: the real agent check over the fake opponent, and a measured Elo per level. */
const CHECKED: FinishOptions = { verifyAgent: (rec) => checkAgentMoves(rec, { makeAgent: async (g) => fakeAgent(g) }), siteElo }

async function begin(game: GameId, who: { userId?: string; guestId?: string } = USER, seed = 21, extra: Record<string, unknown> = {}) {
  const r = await startMatchHandler(db, { game, level: 'hard', ...extra }, who, { seed: () => seed })
  expect(r.status).toBe(200)
  return r.body as { matchId: string; seed: number }
}
const ratingOf = async (game: GameId, who = USER.userId) => (await db.select().from(schema.rating).where(and(eq(schema.rating.userId, who), eq(schema.rating.game, game))))[0]
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
const finish = (rec: MatchRecordV1, who: { userId?: string; guestId?: string } = USER) => finishMatchHandler(db, encodeRecord(rec), who, CHECKED)

/** What a resignation costs a new player at this level: the amount a charged record must cost, to the point. */
async function resignPrice(game: GameId, opts: FinishOptions = CHECKED): Promise<number> {
  const m = await begin(game, CONTROL)
  expect((await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, CONTROL, opts)).status).toBe(200)
  const after = (await ratingOf(game, CONTROL.userId))!.elo
  expect(after).toBeLessThan(1000)
  return after
}

/** A record of a real game of a turn game, played to its end under the issued match id and seed. */
const played = (game: GameId, m: { matchId: string; seed: number }) => play(game, m.seed, undefined, 'hard', m.matchId)

/** A record that decodes and names the match, for tests that never reach the replay. */
const stub = (game: GameId, matchId: string, seed: number): MatchRecordV1 => ({
  schema: 1, matchId, game, coreVersion: getCore(game).version, agent: { version: 'v1', level: 'hard' }, seed, humanSeat: 0, actions: [],
  result: { winner: 0, score: [1, 0], reason: 'x' }, finalHash: '0123456789abcdef', startedAt: '2026-10-23T10:00:00.000Z', endedAt: '2026-10-23T10:01:00.000Z',
  device: 'desktop', input: 'mouse', trainingAllowed: true,
})

/** Plays a signed-in Word Duel through the server's marks to the end and returns the honest record. `swapFirst` puts another word in round one, so the record replays but is not what the server marked. */
async function playedWord(m: { matchId: string }, swapFirst?: string): Promise<MatchRecordV1> {
  const guesses: string[] = []
  let reveal: WordMarksBody['reveal']
  for (const w of ['crane', 'slate', 'house', 'pilot', 'mound', 'fjord']) {
    guesses.push(w)
    const r = await wordMarksHandler(db, { matchId: m.matchId, guesses }, USER)
    expect(r.status).toBe(200)
    const body = r.body as WordMarksBody
    if (body.over) { reveal = body.reveal; break }
  }
  const seed = reveal!.seed
  const mine = swapFirst ? [swapFirst, ...guesses.slice(1)] : guesses
  const actions: MatchRecordV1['actions'] = []
  let s = wordCore.init(seed)
  for (let r = 0; r < mine.length; r++) {
    actions.push([r, 0, wordCore.encodeAction(mine[r]!)], [r, 1, wordCore.encodeAction(reveal!.agentGuesses[r]!)])
    s = wordCore.step(s, [mine[r]!, reveal!.agentGuesses[r]!])
  }
  return { ...stub('word', m.matchId, seed), actions, result: wordCore.result(s)!, finalHash: wordCore.hash(s) }
}

describe('a record that contradicts its match is charged as a loss, like a resignation', () => {
  for (const game of ['chess', 'four', 'holdem'] as const) {
    test(`${game}: real play, the wrong seed: the same loss as a resign, and a later resign is refused`, async () => {
      const price = await resignPrice(game)
      const m = await begin(game)
      const rec = await played(game, m)
      const r = await finish({ ...rec, seed: rec.seed + 1 })
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ valid: false, result: null, elo: { before: 1000, after: price }, provisional: false })
      expect((r.body as { reason: string }).reason).toContain('seed')
      expect(await ratingOf(game)).toMatchObject({ elo: price, games: 1 })
      expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false })
      expect((await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, USER, CHECKED)).status).toBe(409)
      expect(await ratingOf(game)).toMatchObject({ elo: price, games: 1 })
    })
  }

  test('word: real rounds through the server marks, the wrong seed: the same loss as a resign', async () => {
    const price = await resignPrice('word')
    const m = await begin('word')
    const rec = await playedWord(m)
    const r = await finish({ ...rec, seed: rec.seed + 1 })
    expect(r.body).toMatchObject({ valid: false, elo: { before: 1000, after: price } })
    expect(await ratingOf('word')).toMatchObject({ elo: price, games: 1 })
  })

  test('the level is the row\'s: a record claiming Easy on a Hard match costs the Hard price', async () => {
    const price = await resignPrice('four')
    const m = await begin('four')
    const rec = await played('four', m)
    const r = await finish({ ...rec, agent: { ...rec.agent, level: 'easy' } })
    expect((r.body as { reason: string }).reason).toContain('level mismatch')
    expect(r.body).toMatchObject({ elo: { before: 1000, after: price } })
  })

  test('the level is the row\'s with no measured Elo too: a record claiming Easy on a Hard match costs the Hard provisional price', async () => {
    const unmeasured: FinishOptions = { ...CHECKED, siteElo: () => null }
    const price = await resignPrice('four', unmeasured)
    expect(price).toBe(996)
    const m = await begin('four')
    const rec = await played('four', m)
    const r = await finishMatchHandler(db, encodeRecord({ ...rec, agent: { ...rec.agent, level: 'easy' } }), USER, unmeasured)
    expect((r.body as { reason: string }).reason).toContain('level mismatch')
    expect(r.body).toMatchObject({ elo: { before: 1000, after: price }, provisional: true })
    expect(await ratingOf('four')).toMatchObject({ elo: price, games: 1 })
  })

  test('the seat is the server\'s: a wrong seed sent from seat 1 is a loss, never the win that seat would score', async () => {
    const price = await resignPrice('four')
    const m = await begin('four')
    const rec = await played('four', m)
    const r = await finish({ ...rec, seed: rec.seed + 1, humanSeat: 1 })
    expect((r.body as { reason: string }).reason).toContain('seed')
    expect(r.body).toMatchObject({ valid: false, elo: { before: 1000, after: price } })
    expect((await ratingOf('four'))!.elo).toBeLessThan(1000)
  })

  test('the game is the row\'s: a Four match uploaded as chess costs Four rating and leaves chess alone', async () => {
    const price = await resignPrice('four')
    const m = await begin('four')
    const r = await finish(stub('chess', m.matchId, m.seed))
    expect((r.body as { reason: string }).reason).toContain('game mismatch')
    expect(await ratingOf('four')).toMatchObject({ elo: price, games: 1 })
    expect(await ratingOf('chess')).toBeUndefined()
  })

  test('the change is kept with the match, like any rated result', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    await finish({ ...rec, seed: rec.seed + 1 })
    const report = (await db.select().from(schema.matchReport).where(eq(schema.matchReport.matchId, m.matchId)))[0]!
    const rating = (await ratingOf('four'))!
    expect(report).toMatchObject({ eloBefore: 1000, eloAfter: rating.elo, provisional: false })
  })

  test('a level with no measured Elo charges a provisional loss, as a resign does', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    const r = await finishMatchHandler(db, encodeRecord({ ...rec, seed: rec.seed + 1 }), USER, { ...CHECKED, siteElo: () => null })
    expect(r.body).toMatchObject({ valid: false, provisional: true })
    expect((await ratingOf('four'))?.elo).toBeLessThan(1000)
  })
})

describe('a seat flip costs the loss: the server holds the player to seat 0', () => {
  test('word: real rounds uploaded from seat 1: the same loss as a resign', async () => {
    const price = await resignPrice('word')
    const m = await begin('word')
    const r = await finish({ ...(await playedWord(m)), humanSeat: 1 })
    expect((r.body as { reason: string }).reason).toBe('a sealed match is played from seat 0')
    expect(r.body).toMatchObject({ valid: false, result: null, elo: { before: 1000, after: price } })
    expect(await ratingOf('word')).toMatchObject({ elo: price, games: 1 })
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false })
  })

  for (const game of ['chess', 'four', 'holdem'] as const) {
    test(`${game}: the agent check refuses seat 1: the same loss as a resign`, async () => {
      const price = await resignPrice(game)
      const m = await begin(game)
      const r = await finish({ ...(await played(game, m)), humanSeat: 1 })
      expect((r.body as { reason: string }).reason).toContain('only a human in seat 0 can be checked')
      expect(r.body).toMatchObject({ valid: false, result: null, elo: { before: 1000, after: price } })
      expect(await ratingOf(game)).toMatchObject({ elo: price, games: 1 })
    })
  }

  test('charged once: the same seat 1 record again is 409', async () => {
    const m = await begin('four')
    const flipped = { ...(await played('four', m)), humanSeat: 1 as const }
    await finish(flipped)
    const rating = await ratingOf('four')
    expect((await finish(flipped)).status).toBe(409)
    expect(await ratingOf('four')).toEqual(rating)
  })

  test('honest seat 0 records are not touched: a loss is the real loss and a refused record stays free', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    expect(rec.humanSeat).toBe(0)
    const r = await finish({ ...rec, coreVersion: 'four-0' })
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await ratingOf('four')).toBeUndefined()
  })

  test('a practice match, a guest and an offline ticket stay free from seat 1', async () => {
    const practice = await begin('four', USER, 21, { practice: true })
    expect((await finish({ ...(await played('four', practice)), humanSeat: 1 })).body).toMatchObject({ valid: false })
    const guest = await begin('four', GUEST)
    expect((await finish({ ...(await played('four', guest)), humanSeat: 1 }, GUEST)).body).toMatchObject({ valid: false })
    const t = (await issueTicketsHandler(db, { game: 'four', level: 'hard', count: 1 }, USER, { agentVersion: () => 'v1' })).body as { tickets: Ticket[] }
    const ticket = t.tickets[0]!
    const r = await finish({ ...(await played('four', { matchId: ticket.matchId, seed: ticket.seed })), humanSeat: 1 })
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await db.select().from(schema.rating)).toEqual([])
  })
})

describe('never charged: no rating is at stake', () => {
  test('a practice match', async () => {
    const m = await begin('four', USER, 21, { practice: true })
    const rec = await played('four', m)
    const r = await finish({ ...rec, seed: rec.seed + 1 })
    expect(r.body).toEqual({ valid: false, reason: 'seed does not match the one issued for this match', result: null })
    expect(await ratingOf('four')).toBeUndefined()
  })

  test('a guest', async () => {
    const m = await begin('four', GUEST)
    const rec = await played('four', m)
    const r = await finish({ ...rec, seed: rec.seed + 1 }, GUEST)
    expect(r.body).toMatchObject({ valid: false })
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await db.select().from(schema.rating)).toEqual([])
  })

  for (const game of ['fighter', 'arena'] as const) {
    test(`${game}: a game with no rating`, async () => {
      const m = await begin(game)
      const r = await finish(stub(game, m.matchId, m.seed + 1))
      expect(r.body).toEqual({ valid: false, reason: 'seed does not match the one issued for this match', result: null })
      expect(await ratingOf(game)).toBeUndefined()
    })
  }
})

describe('never charged: an honest failure looks the same', () => {
  /** After the settling answer nothing is charged, then or later: the abandon sweep leaves the row alone. */
  async function freeOfCharge(game: GameId, matchId: string, r: { status: number; body: unknown }) {
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ valid: false, result: null })
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await abandonStale(db, new Date(Date.now() + 24 * 3600_000), { siteElo })).toBe(0)
    expect(await ratingOf(game)).toBeUndefined()
    expect(await rowOf(matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false })
  }

  test('a truncated upload never reaches the row: the honest copy still counts, once', async () => {
    const m = await begin('four')
    const bytes = encodeRecord(await played('four', m))
    for (const cut of [bytes.slice(0, 10), bytes.slice(0, Math.floor(bytes.length / 2)), bytes.slice(0, bytes.length - 1)]) {
      expect((await finishMatchHandler(db, cut, USER, CHECKED)).status).toBe(400)
      expect((await rowOf(m.matchId)).status).toBe('started')
    }
    expect(await ratingOf('four')).toBeUndefined()
    const r = await finishMatchHandler(db, bytes, USER, CHECKED)
    expect(r.body).toMatchObject({ valid: true })
    expect((await ratingOf('four'))?.games).toBe(1)
  })

  test('an older build: the core version differs', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    await freeOfCharge('four', m.matchId, await finish({ ...rec, coreVersion: 'four-0' }))
  })

  test('an older Hold\'em build: the match length differs from the one the server stored', async () => {
    const m = await begin('holdem', USER, 21, { options: { hands: 5 } })
    const rec = await played('holdem', m)
    const r = await finish(rec)
    expect((r.body as { reason: string }).reason).toContain('match length')
    await freeOfCharge('holdem', m.matchId, r)
  })

  test('a client bug: the page uploads a record its own replay failed', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    const r = await finish({ ...rec, actions: rec.actions.slice(0, -1) })
    expect((r.body as { reason: string }).reason).toContain('ends before')
    await freeOfCharge('four', m.matchId, r)
  })

  test('the opponent was updated mid-match: the check says the agent moves differ', async () => {
    const m = await begin('four')
    const r = await finish(await play('four', m.seed, 1, 'hard', m.matchId))
    expect((r.body as { reason: string }).reason).toContain('not the ones the opponent plays')
    await freeOfCharge('four', m.matchId, r)
  })

  test('the server could not run the check', async () => {
    const m = await begin('four')
    const r = await finishMatchHandler(db, encodeRecord(await played('four', m)), USER, { siteElo, verifyAgent: async () => ({ kind: 'unverified', reason: 'no model' }) })
    await freeOfCharge('four', m.matchId, r)
  })

  test('a Word Duel record that replays but is not what the server marked', async () => {
    const m = await begin('word')
    const r = await finish(await playedWord(m, 'plumb'))
    expect((r.body as { reason: string }).reason).toBe('record does not match the marked rounds')
    await freeOfCharge('word', m.matchId, r)
  })

  describe('an offline ticket', () => {
    async function ticket(): Promise<Ticket> {
      const r = await issueTicketsHandler(db, { game: 'four', level: 'hard', count: 1 }, USER, { agentVersion: () => 'v1' })
      return (r.body as { tickets: Ticket[] }).tickets[0]!
    }
    const ticketed = async (t: Ticket) => played('four', { matchId: t.matchId, seed: t.seed })

    test('its record is refused for any reason, the seed included, and costs nothing: it was played out of the server\'s sight', async () => {
      const t = await ticket()
      const rec = await ticketed(t)
      await freeOfCharge('four', t.matchId, await finish({ ...rec, seed: rec.seed + 1 }))
    })

    test('a copy sent after the first upload died in the agent check is still a ticket: free of charge', async () => {
      const t = await ticket()
      const rec = await ticketed(t)
      const dies: FinishOptions = { ...CHECKED, verifyAgent: async () => { throw new Error('the check died') } }
      await expect(finishMatchHandler(db, encodeRecord(rec), USER, dies)).rejects.toThrow('the check died')
      expect(await rowOf(t.matchId)).toMatchObject({ status: 'started' })
      await freeOfCharge('four', t.matchId, await finish({ ...rec, seed: rec.seed + 1 }))
    })

    test('the opponent moved on while it waited in the queue', async () => {
      const t = await ticket()
      const r = await finishMatchHandler(db, encodeRecord(await ticketed(t)), USER, { ...CHECKED, currentAgentVersion: () => 'v2' })
      expect((r.body as { reason: string }).reason).toContain('updated after this offline ticket')
      await freeOfCharge('four', t.matchId, r)
    })

    test('an honest queued record still counts, once', async () => {
      const t = await ticket()
      const rec = await ticketed(t)
      expect((await finish(rec)).body).toMatchObject({ valid: true })
      expect((await finish(rec)).status).toBe(409)
      expect((await ratingOf('four'))?.games).toBe(1)
    })
  })
})

describe('once only, and only while the match is open', () => {
  test('the same bad record twice is charged once; the second answer is 409', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    const bad = { ...rec, seed: rec.seed + 1 }
    await finish(bad)
    const rating = await ratingOf('four')
    expect(rating?.games).toBe(1)
    expect((await finish(bad)).status).toBe(409)
    expect(await ratingOf('four')).toEqual(rating)
  })

  test('five copies at once are charged once', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    const answers = await Promise.all(Array.from({ length: 5 }, () => finish({ ...rec, seed: rec.seed + 1 })))
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1)
    expect(answers.filter((a) => a.status === 409)).toHaveLength(4)
    expect((await ratingOf('four'))?.games).toBe(1)
  })

  test('a record retried after a success changes nothing, honest or edited', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    expect((await finish(rec)).body).toMatchObject({ valid: true })
    const rating = await ratingOf('four')
    const retry = await finish(rec)
    expect(retry.status).toBe(409)
    expect(retry.body).toMatchObject({ valid: true })
    expect((await finish({ ...rec, seed: rec.seed + 1 })).status).toBe(409)
    expect(await ratingOf('four')).toEqual(rating)
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: true })
  })

  test('after a resign a bad record changes nothing', async () => {
    const m = await begin('four')
    await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, USER, CHECKED)
    const rating = await ratingOf('four')
    expect((await finish({ ...(await played('four', m)), seed: m.seed + 1 })).status).toBe(409)
    expect(await ratingOf('four')).toEqual(rating)
  })

  test('after the abandon sweep a bad record changes nothing, and after a charge the sweep changes nothing', async () => {
    const swept = await begin('four')
    expect(await abandonStale(db, new Date(Date.now() + 24 * 3600_000), { siteElo })).toBe(1)
    const rating = await ratingOf('four')
    expect((await finish({ ...(await played('four', swept)), seed: swept.seed + 1 })).status).toBe(409)
    expect(await ratingOf('four')).toEqual(rating)

    const charged = await begin('four')
    await finish({ ...(await played('four', charged)), seed: charged.seed + 1 })
    const after = await ratingOf('four')
    expect(after?.games).toBe(2)
    expect(await abandonStale(db, new Date(Date.now() + 24 * 3600_000), { siteElo })).toBe(0)
    expect(await ratingOf('four')).toEqual(after)
  })

  test('nobody can get another player charged: their upload is refused and the match stays open', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    expect((await finish({ ...rec, seed: rec.seed + 1 }, OTHER)).status).toBe(403)
    expect((await rowOf(m.matchId)).status).toBe('started')
    expect(await ratingOf('four')).toBeUndefined()
    expect(await ratingOf('four', OTHER.userId)).toBeUndefined()
  })
})

describe('an invalid record is never a win', () => {
  test('claiming a win: the rating falls, and no board, path, result list or training read counts it', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    const r = await finish({ ...rec, seed: rec.seed + 1, result: { winner: 0, score: [1, 0], reason: 'four in a row' } })
    expect(r.body).toMatchObject({ valid: false, result: null })
    const after = (await ratingOf('four'))!
    expect(after.elo).toBeLessThan(1000)
    expect(await getUserRating(db, USER.userId, 'four')).toEqual({ elo: after.elo, games: 1 })
    expect(await getPath(db, USER, 'four')).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(await finishedResults(db, { game: 'four', since: new Date(0) })).toEqual([])
    expect(await listTrainingMatches(db, 'four')).toEqual([])
  })

  test('the opposite direction stays closed: a record refused for any other reason gives no rating at all', async () => {
    const m = await begin('four')
    const rec = await played('four', m)
    await finish({ ...rec, coreVersion: 'four-0', result: { winner: 0, score: [1, 0], reason: 'four in a row' } })
    expect(await ratingOf('four')).toBeUndefined()
    expect(await finishedResults(db, { game: 'four', since: new Date(0) })).toEqual([])
    expect(await listTrainingMatches(db, 'four')).toEqual([])
  })
})

describe('Stormglass: the seed is revealed after a loss, so the server\'s own log decides an edited record', () => {
  const place = (p: { cell: number; vertical: boolean }) => fleetCore.encodeAction({ kind: 'place', cell: p.cell, vertical: p.vertical })
  const MINE = randomFleet(makeRng(7))
  const THEIRS = randomFleet(makeRng(8))
  const cellsOf = (fleet: Placement[]) => fleet.flatMap((p) => shipCells(p))
  const waterOf = (fleet: Placement[]) => Array.from({ length: 100 }, (_, c) => c).filter((c) => !cellsOf(fleet).includes(c))
  /** The real handler over an opponent with a known fleet: it shoots my ships when the game is one the player loses and open water otherwise. */
  const scripted = (shots: number[]): SealedSpec => ({
    ...FLEET_SPEC,
    agentAction: (_level, _seed, _obs, _seat, tick) => (tick < 5 ? place(THEIRS[tick]!) : shotCode(shots[tick - 5]!)),
  })
  type Who = { userId?: string; guestId?: string }

  /** Plays through the real turn handler: the setup, then `count` shots from `mine`. Returns the player's list and the last reply. */
  async function shoot(m: { matchId: string }, mine: number[], theirs: number[], count: number, who: Who = USER) {
    const spec = scripted(theirs)
    const human = MINE.map(place)
    let last = (await sealedTurnHandler(db, { matchId: m.matchId, actions: human }, who, spec)).body as SealedTurnBody
    for (const cell of mine.slice(0, count)) {
      human.push(shotCode(cell))
      const r = await sealedTurnHandler(db, { matchId: m.matchId, actions: human }, who, spec)
      expect(r.status).toBe(200)
      last = r.body as SealedTurnBody
    }
    return { human, last }
  }
  /** The honest record, built by the page's own function from what the server revealed. */
  function recordOf(matchId: string, human: number[], last: SealedTurnBody): MatchRecordV1 {
    expect(last.over).toBe(true)
    const { seed, agentActions } = last.reveal!
    const { actions, state } = recordFromLists(seed, human, agentActions)
    return { ...stub('fleet', matchId, seed), actions, result: fleetCore.result(state)!, finalHash: fleetCore.hash(state) }
  }
  async function lostGame(who: Who = USER, extra: Record<string, unknown> = {}) {
    const m = await begin('fleet', who, 21, extra)
    const { human, last } = await shoot(m, waterOf(THEIRS), cellsOf(MINE), 17, who)
    expect(last.view).toMatchObject({ phase: 'over' })
    return { m, rec: recordOf(m.matchId, human, last) }
  }
  async function wonGame(who: Who = USER) {
    const m = await begin('fleet', who)
    const { human, last } = await shoot(m, cellsOf(THEIRS), waterOf(MINE), 17, who)
    const rec = recordOf(m.matchId, human, last)
    expect(rec.result.winner).toBe(0)
    return { m, rec }
  }
  /** What a resignation costs a new player in a played Stormglass match at this level. */
  async function fleetPrice(): Promise<number> {
    const m = await begin('fleet', CONTROL)
    await shoot(m, waterOf(THEIRS), cellsOf(MINE), 1, CONTROL)
    expect((await resignMatchHandler(db, { matchId: m.matchId, tick: 6 }, CONTROL, CHECKED)).status).toBe(200)
    const after = (await ratingOf('fleet', CONTROL.userId))!.elo
    expect(after).toBeLessThan(1000)
    return after
  }
  const noRating = async () => expect(await db.select().from(schema.rating).where(eq(schema.rating.userId, USER.userId))).toEqual([])
  /** The player's first two shots swapped, with the hash fixed up: the record replays to the same end but is not the logged match. */
  function swappedShots(rec: MatchRecordV1): MatchRecordV1 {
    const [a, b] = rec.actions.map((e, i) => (e[1] === 0 && e[0] >= 5 ? i : -1)).filter((i) => i >= 0)
    const actions = rec.actions.map((e, i) => (i === a ? ([e[0], e[1], rec.actions[b!]![2]] as typeof e) : i === b ? ([e[0], e[1], rec.actions[a!]![2]] as typeof e) : e))
    return { ...rec, actions, finalHash: hashOf(rec, actions) }
  }
  function hashOf(rec: MatchRecordV1, actions: MatchRecordV1['actions']): string {
    let s = fleetCore.init(rec.seed)
    for (let t = 0, i = 0; !fleetCore.terminal(s); t++) {
      const step: [unknown, unknown] = [null, null]
      for (; i < actions.length && actions[i]![0] === t; i++) step[actions[i]![1]] = fleetCore.decodeAction(actions[i]![2])
      s = fleetCore.step(s, step as never)
    }
    return fleetCore.hash(s)
  }

  const EDITS: Array<[string, (r: MatchRecordV1) => MatchRecordV1, RegExp]> = [
    ["coreVersion 'fleet-0'", (r) => ({ ...r, coreVersion: 'fleet-0' }), /core version/],
    ['finalHash zeros', (r) => ({ ...r, finalHash: '0000000000000000' }), /final hash/],
    ['humanSeat 1', (r) => ({ ...r, humanSeat: 1 }), /seat 0/],
    ['one action code changed, no longer replays', (r) => ({ ...r, actions: r.actions.map((e, i) => (i === r.actions.length - 1 ? ([e[0], e[1], e[2] === 299 ? 298 : 299] as typeof e) : e)) }), /./],
    ['one action code changed, still replays', swappedShots, /logged turns/],
  ]

  test('the honest records are valid: a loss is the real loss and a win is a gain', async () => {
    const lost = await lostGame()
    const down = (await finish(lost.rec)).body as { valid: boolean; elo: { before: number; after: number } }
    expect(down.valid).toBe(true)
    expect(down.elo.after).toBeLessThan(1000)
    expect(await rowOf(lost.m.matchId)).toMatchObject({ recordValid: true, result: { winner: 1 } })
    await db.execute(sql`truncate table rating`)
    const won = await wonGame()
    const up = (await finish(won.rec)).body as { valid: boolean; elo: { before: number; after: number } }
    expect(up.valid).toBe(true)
    expect(up.elo.after).toBeGreaterThan(1000)
  })

  for (const [name, edit, why] of EDITS) {
    test(`after a real loss, ${name}: the same loss as a resign, charged once, and the row holds what really happened`, async () => {
      const price = await fleetPrice()
      const { m, rec } = await lostGame()
      const bad = edit(rec)
      const r = await finish(bad)
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ valid: false, result: null, elo: { before: 1000, after: price } })
      expect((r.body as { reason: string }).reason).toMatch(why)
      expect(await ratingOf('fleet')).toMatchObject({ elo: price, games: 1 })
      expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false, result: { winner: 1, score: [0, 1], reason: 'fleet sunk' } })
      const rating = await ratingOf('fleet')
      expect((await finish(bad)).status).toBe(409)
      expect((await finish(rec)).status).toBe(409)
      expect(await ratingOf('fleet')).toEqual(rating)
    })

    test(`after a real win, ${name}: no gain, no charge, and the row says the player won with the record refused`, async () => {
      const { m, rec } = await wonGame()
      const bad = edit(rec)
      const r = await finish(bad)
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ valid: false, result: null })
      expect((r.body as { elo?: unknown }).elo).toBeUndefined()
      await noRating()
      expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, record: null, trainingAllowed: false, result: { winner: 0, score: [1, 0], reason: 'fleet sunk' } })
      expect((await finish(bad)).status).toBe(409)
      expect((await finish(rec)).status).toBe(409)
      await noRating()
      expect(await getUserRating(db, USER.userId, 'fleet')).toBeNull()
      expect(await getPath(db, USER, 'fleet')).toEqual({ easy: false, medium: false, hard: false, champion: false })
      expect(await finishedResults(db, { game: 'fleet', since: new Date(0) })).toEqual([])
      expect(await listTrainingMatches(db, 'fleet')).toEqual([])
    })
  }

  test('a won game with the wrong seed: the log says won, so no charge', async () => {
    const { rec } = await wonGame()
    const r = await finish({ ...rec, seed: rec.seed + 1 })
    expect((r.body as { reason: string }).reason).toContain('seed')
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    await noRating()
  })

  test('a lost game claiming the win: the same loss, the claim is not kept, and no read counts it', async () => {
    const price = await fleetPrice()
    const { m, rec } = await lostGame()
    const r = await finish({ ...rec, result: { winner: 0, score: [1, 0], reason: 'fleet sunk' } })
    expect(r.body).toMatchObject({ valid: false, elo: { before: 1000, after: price } })
    expect((await rowOf(m.matchId)).result).toMatchObject({ winner: 1 })
    expect(await finishedResults(db, { game: 'fleet', since: new Date(0) })).toEqual([])
  })

  test('the level and game are the row\'s: a record naming Easy or another game costs the Hard Stormglass price', async () => {
    const price = await fleetPrice()
    const easy = await lostGame()
    const a = await finish({ ...easy.rec, agent: { ...easy.rec.agent, level: 'easy' } })
    expect(a.body).toMatchObject({ valid: false, elo: { before: 1000, after: price } })
    await db.execute(sql`truncate table rating`)
    const other = await lostGame()
    const b = await finish({ ...other.rec, game: 'four' })
    expect(b.body).toMatchObject({ valid: false, elo: { before: 1000, after: price } })
    expect(await ratingOf('four')).toBeUndefined()
  })

  test('five copies of an edited record at once are charged once', async () => {
    const { rec } = await lostGame()
    const answers = await Promise.all(Array.from({ length: 5 }, () => finish({ ...rec, coreVersion: 'fleet-0' })))
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1)
    expect(answers.filter((a) => a.status === 409)).toHaveLength(4)
    expect((await ratingOf('fleet'))?.games).toBe(1)
  })

  test('a match still running: the page never uploads one, so any upload is charged as giving up, and the row keeps no result', async () => {
    const price = await fleetPrice()
    const m = await begin('fleet')
    const { last } = await shoot(m, waterOf(THEIRS), cellsOf(MINE), 3)
    expect(last.over).toBe(false)
    const r = await finish({ ...stub('fleet', m.matchId, 21), coreVersion: 'fleet-0', result: { winner: 0, score: [1, 0], reason: 'fleet sunk' } })
    expect(r.body).toMatchObject({ valid: false, result: null, elo: { before: 1000, after: price } })
    expect(await ratingOf('fleet')).toMatchObject({ elo: price, games: 1 })
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, result: null })
    const stale = await sealedTurnHandler(db, { matchId: m.matchId, actions: MINE.map(place) }, USER, scripted(cellsOf(MINE)))
    expect(stale.status).toBe(409)
  })

  test('a shot that lands between the read and the write sends the upload back: a free unplayed row cannot end on a shot, and the next try is charged', async () => {
    const price = await fleetPrice()
    const m = await begin('fleet')
    const { human } = await shoot(m, [], [], 0)
    let landed = false
    /** The database as the finish handler sees it: one shot lands just before its write. */
    const racing = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'update' || landed) return Reflect.get(target, key, receiver)
        return (table: typeof schema.match) => ({
          set: (values: Record<string, unknown>) => ({
            where: (cond: never) => ({
              returning: async (cols: never) => {
                landed = true
                expect((await sealedTurnHandler(db, { matchId: m.matchId, actions: [...human, shotCode(waterOf(THEIRS)[0]!)] }, USER, scripted(cellsOf(MINE)))).status).toBe(200)
                return target.update(table).set(values).where(cond).returning(cols)
              },
            }),
          }),
        })
      },
    })
    const bad = { ...stub('fleet', m.matchId, 21), coreVersion: 'fleet-0' }
    expect((await finishMatchHandler(racing, encodeRecord(bad), USER, CHECKED)).status).toBe(409)
    expect(await rowOf(m.matchId)).toMatchObject({ status: 'started' })
    await noRating()
    expect((await finish(bad)).body).toMatchObject({ valid: false, elo: { before: 1000, after: price } })
  })

  test('the turn handler cannot run past a charge: resign and the abandon sweep change nothing after it', async () => {
    const { m, rec } = await lostGame()
    await finish({ ...rec, finalHash: '0000000000000000' })
    const rating = await ratingOf('fleet')
    expect((await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, USER, CHECKED)).status).toBe(409)
    await abandonStale(db, new Date(Date.now() + 1e9), CHECKED)
    expect(await ratingOf('fleet')).toEqual(rating)
  })

  describe('a match the server\'s log says the player won is never charged by resign or either abandon sweep', () => {
    /** The winning shot is stored but the player never learned it (tab closed, both replies lost, Resign pressed while thinking). */
    async function wonUnseen(who: Who = USER, extra: Record<string, unknown> = {}) {
      const m = await begin('fleet', who, 21, extra)
      const { last } = await shoot(m, cellsOf(THEIRS), waterOf(MINE), 17, who)
      expect(last.over).toBe(true)
      return m
    }
    const FAR = () => new Date(Date.now() + 1e9)
    /** The row keeps the hidden setup for later, and neither the record nor the competitive reads show it. */
    async function expectKept(id: string, status: 'resigned' | 'abandoned') {
      const row = await rowOf(id)
      expect(row.status).toBe(status)
      expect((row.filterFlags as { sealedLog?: { human: number[] } }).sealedLog?.human.length).toBeGreaterThan(5)
      expect(row.filterFlags).toMatchObject({ loggedWin: true })
      const rec = await getMyRecord(db, USER.userId)
      expect(rec.perGame).toEqual([])
      expect(rec.recent).toEqual([])
      expect(JSON.stringify(rec)).not.toContain('sealedLog')
    }

    test('resign: no rating, no charge, the row says so', async () => {
      const m = await wonUnseen()
      const r = await resignMatchHandler(db, { matchId: m.matchId, tick: 40 }, USER, CHECKED)
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ resigned: true })
      await noRating()
      await expectKept(m.matchId, 'resigned')
    })

    test('an honest win that was uploaded still counts on the record', async () => {
      const { m, rec } = await wonGame()
      expect((await rowOf(m.matchId)).filterFlags).toMatchObject({ loggedWin: true })
      expect(((await finish(rec)).body as { valid: boolean }).valid).toBe(true)
      expect((await getMyRecord(db, USER.userId)).perGame).toMatchObject([{ game: 'fleet', total: 1, won: 1 }])
    })

    test('resign still charges a match that is running, and keeps its log', async () => {
      const price = await fleetPrice()
      const m = await begin('fleet')
      await shoot(m, waterOf(THEIRS), cellsOf(MINE), 2)
      const r = await resignMatchHandler(db, { matchId: m.matchId, tick: 9 }, USER, CHECKED)
      expect(r.body).toMatchObject({ resigned: true, elo: { before: 1000, after: price } })
      const row = await rowOf(m.matchId)
      expect(row.filterFlags).toMatchObject({ resigned: true, resignTick: 9 })
      expect((row.filterFlags as Record<string, unknown>).loggedWin).toBeUndefined()
      expect((row.filterFlags as { sealedLog?: unknown }).sealedLog).toBeDefined()
    })

    test('the stale abandon sweep: no rating, the row says so', async () => {
      const m = await wonUnseen()
      expect(await abandonStale(db, FAR(), CHECKED)).toBe(1)
      await noRating()
      await expectKept(m.matchId, 'abandoned')
    })

    test('the over-cap sweep (three new starts): no rating, the row says so', async () => {
      const m = await wonUnseen()
      for (let i = 0; i < 3; i++) await begin('word')
      expect((await rowOf(m.matchId)).status).toBe('abandoned')
      await noRating()
      await expectKept(m.matchId, 'abandoned')
    })

    test('the sweeps still charge a match that is running, and keep its log', async () => {
      const price = await fleetPrice()
      const m = await begin('fleet')
      await shoot(m, waterOf(THEIRS), cellsOf(MINE), 2)
      expect(await abandonStale(db, FAR(), CHECKED)).toBe(1)
      expect((await ratingOf('fleet'))!.elo).toBe(price)
      const row = await rowOf(m.matchId)
      expect(row.status).toBe('abandoned')
      expect((row.filterFlags as { sealedLog?: unknown }).sealedLog).toBeDefined()
      expect((row.filterFlags as Record<string, unknown>).loggedWin).toBeUndefined()
      expect((await getMyRecord(db, USER.userId)).perGame).toMatchObject([{ game: 'fleet', total: 1, won: 0 }])
    })

    test('an honest uploaded win is no filter reason: the public funnel shows no loggedWin and counts it as passed', async () => {
      const { rec } = await wonGame()
      expect(((await finish(rec)).body as { valid: boolean }).valid).toBe(true)
      const stats = await getGameStats(db, 'fleet')
      expect(stats.funnel.reasons).toEqual({})
      expect(stats.funnel).toMatchObject({ finished: 1, passedFilters: 1 })
      expect(JSON.stringify(stats)).not.toContain('loggedWin')
      // The player's own list must not read the marker as a filter either (landing learningOf).
      expect((await getMyRecord(db, USER.userId)).recent[0]!.learning).toBe('Eligible for training')
    })

    test('a logged win given up is no loss on the report or the card', async () => {
      const m = await wonUnseen()
      await resignMatchHandler(db, { matchId: m.matchId, tick: 40 }, USER, CHECKED)
      const view = (await getReport(db, m.matchId, USER))!
      expect(view.status).toBe('resigned')
      expect(view.body!.outcome).toBe('win')
      expect(view.body!.reason).not.toMatch(/resigned/i)
      expect(view.owner!.rating).toBeNull()
      expect(await getCardFacts(db, m.matchId)).toBeNull()
      const other = await wonUnseen()
      await abandonStale(db, FAR(), CHECKED)
      expect((await getReport(db, other.matchId, USER))!.body!.outcome).toBe('win')
      expect(await getCardFacts(db, other.matchId)).toBeNull()
    })

    test('a logged LOSS given up with no upload is charged by resign and by both sweeps, at the price of a resign', async () => {
      const price = await fleetPrice()
      await db.execute(sql`truncate table rating`)
      const lost = await lostGame()
      const r = await resignMatchHandler(db, { matchId: lost.m.matchId, tick: 40 }, USER, CHECKED)
      expect(r.body).toMatchObject({ resigned: true, elo: { before: 1000, after: price } })
      await db.execute(sql`truncate table rating`)
      const stale = await lostGame()
      expect(await abandonStale(db, FAR(), CHECKED)).toBe(1)
      expect((await ratingOf('fleet'))!.elo).toBe(price)
      expect((await rowOf(stale.m.matchId)).filterFlags).toMatchObject({ abandoned: true })
      expect((await getMyRecord(db, USER.userId)).perGame).toMatchObject([{ game: 'fleet', total: 2, won: 0 }])
      await db.execute(sql`truncate table rating`)
      const capped = await lostGame()
      for (let i = 0; i < 3; i++) await begin('word')
      expect((await rowOf(capped.m.matchId)).status).toBe('abandoned')
      expect((await ratingOf('fleet'))!.elo).toBe(price)
    })

    test('a practice win left behind and a flag-free game keep their old flags', async () => {
      const p = await wonUnseen(USER, { practice: true })
      await abandonStale(db, FAR(), CHECKED)
      expect((await rowOf(p.matchId)).filterFlags).toMatchObject({ abandoned: true, practice: true })
      const f = await begin('four')
      await abandonStale(db, FAR(), CHECKED)
      expect((await rowOf(f.matchId)).filterFlags).toEqual({ abandoned: true })
      await resignMatchHandler(db, { matchId: (await begin('four')).matchId, tick: 2 }, USER, CHECKED)
    })
  })

  describe('never charged', () => {
    test('a practice match, lost and edited', async () => {
      const { m, rec } = await lostGame(USER, { practice: true })
      const r = await finish({ ...rec, coreVersion: 'fleet-0' })
      expect(r.body).toMatchObject({ valid: false, result: null })
      expect((r.body as { elo?: unknown }).elo).toBeUndefined()
      await noRating()
      expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false })
    })

    test('a practice match still running', async () => {
      const m = await begin('fleet', USER, 21, { practice: true })
      await shoot(m, waterOf(THEIRS), cellsOf(MINE), 2)
      expect((await finish({ ...stub('fleet', m.matchId, 21), coreVersion: 'fleet-0' })).body).toMatchObject({ valid: false, result: null })
      await noRating()
    })

    test('a guest, lost and edited', async () => {
      const { rec } = await lostGame(GUEST)
      const r = await finish({ ...rec, finalHash: '0000000000000000' }, GUEST)
      expect(r.body).toMatchObject({ valid: false, result: null })
      expect(await db.select().from(schema.rating)).toEqual([])
    })

    test('an unplayed row, setup only or nothing stored: an edited record is free, even one that contradicts its match, and a claimed win is not kept', async () => {
      const setupOnly = await begin('fleet')
      await shoot(setupOnly, [], [], 0)
      for (const edit of [{ seed: 22 }, { humanSeat: 1 as const }, { coreVersion: 'fleet-0' }]) {
        const m = await begin('fleet')
        await shoot(m, [], [], 0)
        const r = await finish({ ...stub('fleet', m.matchId, 21), ...edit })
        expect(r.body).toMatchObject({ valid: false, result: null })
        expect((r.body as { elo?: unknown }).elo).toBeUndefined()
        expect(await rowOf(m.matchId)).toMatchObject({ status: 'finished', recordValid: false, result: null })
      }
      const bare = await begin('fleet')
      const r = await finish({ ...stub('fleet', bare.matchId, 21), seed: 22 })
      expect(r.body).toMatchObject({ valid: false, result: null })
      expect((r.body as { elo?: unknown }).elo).toBeUndefined()
      await noRating()
    })
  })

  describe('a stored log the core cannot play (never the player\'s doing): the record alone decides', () => {
    const broken = async () => {
      const m = await begin('fleet')
      await shoot(m, waterOf(THEIRS), cellsOf(MINE), 2)
      const row = await rowOf(m.matchId)
      const log = (row.filterFlags as { sealedLog: { human: number[]; agent: number[] } }).sealedLog
      await db.update(schema.match).set({ filterFlags: { ...row.filterFlags, sealedLog: { ...log, human: [...log.human.slice(0, 5), 99999, 99998] } } }).where(eq(schema.match.id, m.matchId))
      return m
    }

    test('an honest looking failure stays free', async () => {
      const m = await broken()
      const r = await finish({ ...stub('fleet', m.matchId, 21), coreVersion: 'fleet-0' })
      expect((r.body as { elo?: unknown }).elo).toBeUndefined()
      await noRating()
      expect(await rowOf(m.matchId)).toMatchObject({ recordValid: false, result: null })
    })

    test('a seat flip still costs the loss', async () => {
      const m = await broken()
      const r = await finish({ ...stub('fleet', m.matchId, 21), humanSeat: 1, seed: 22 })
      expect((r.body as { elo?: { after: number } }).elo!.after).toBeLessThan(1000)
    })

    test('a seat flip alone still costs the loss: the seat is held in every sealed game', async () => {
      const m = await broken()
      const r = await finish({ ...stub('fleet', m.matchId, 21), humanSeat: 1 })
      expect((r.body as { elo?: { after: number } }).elo!.after).toBeLessThan(1000)
    })
  })
})
