import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import { wordCore } from '@duelwise/core/src/games/word/core'
import type { GameId, Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { abandonStale } from './abandon'
import { checkAgentMoves } from './agent-check'
import { fakeAgent, play } from './agent-check-fixtures'
import { finishMatchHandler, startMatchHandler, type FinishOptions } from './match-handlers'
import { getUserRating } from './leaderboard'
import { getPath } from './path'
import { resignMatchHandler } from './resign'
import { finishedResults } from './results'
import { issueTicketsHandler, type Ticket } from './ticket-issue'
import { listTrainingMatches } from './training-export'
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
async function resignPrice(game: GameId): Promise<number> {
  const m = await begin(game, CONTROL)
  expect((await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, CONTROL, CHECKED)).status).toBe(200)
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
