import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { makeRng } from '@duelwise/core/src/rng'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { abandonStale } from './abandon'
import { applyRating, PROVISIONAL_LEVEL_ELO, ratedSiteElo, START_ELO } from './ratings'
import { getLeaderboard, MIN_GAMES } from './leaderboard'

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
})

const USER = { userId: 'u-1' }
const win = { winner: 0, score: [1, 0], reason: 'x' } as MatchRecordV1['result']
const loss = { winner: 1, score: [0, 1], reason: 'x' } as MatchRecordV1['result']
const draw = { winner: null, score: [0.5, 0.5], reason: 'x' } as MatchRecordV1['result']

const base = { userId: 'u-1', game: 'four' as const, level: 'easy' as const, humanSeat: 0 as const }

describe('applyRating', () => {
  test('does not need db.transaction (neon-http has none)', async () => {
    const noTx = new Proxy(db, {
      get(t, k, r) {
        if (k === 'transaction') return () => { throw new Error('No transactions support in neon-http driver') }
        return Reflect.get(t, k, r)
      },
    }) as Db
    const r = await applyRating(noTx, { ...base, result: win, siteElo: 1000 })
    expect(r.after).toBe(START_ELO + 20)
    expect((await db.select().from(schema.rating))[0]).toMatchObject({ elo: START_ELO + 20, games: 1 })
  })

  test('concurrent matches both count', async () => {
    await Promise.all([1, 2, 3].map(() => applyRating(db, { ...base, result: win, siteElo: 1000 })))
    expect((await db.select().from(schema.rating))[0]!.games).toBe(3)
  })

  test('first win against a measured level uses k 40 and that level site Elo', async () => {
    const r = await applyRating(db, { ...base, result: win, siteElo: 1000 })
    expect(r).toEqual({ before: START_ELO, after: START_ELO + 20, provisional: false })
    const row = (await db.select().from(schema.rating))[0]!
    expect(row).toMatchObject({ userId: 'u-1', game: 'four', elo: START_ELO + 20, games: 1 })
  })

  test('k is 40 for the first 10 games and 24 after', async () => {
    await db.insert(schema.rating).values({ userId: 'u-1', game: 'four', elo: 1000, games: 9 })
    const a = await applyRating(db, { ...base, result: win, siteElo: 1000 })
    expect(a.after - a.before).toBe(20) // game 10 still k 40
    const b = await applyRating(db, { ...base, result: win, siteElo: 1000 })
    expect(b.after - b.before).toBeLessThanOrEqual(12) // game 11 uses k 24 at a higher rating
    expect(b.after - b.before).toBeGreaterThanOrEqual(10)
  })

  test('a loss lowers it and a draw against an equal opponent leaves it', async () => {
    expect((await applyRating(db, { ...base, result: loss, siteElo: 1000 })).after).toBe(980)
    await db.execute(sql`truncate table rating`)
    expect((await applyRating(db, { ...base, result: draw, siteElo: 1000 })).after).toBe(1000)
  })

  test('the human seat decides who won', async () => {
    const r = await applyRating(db, { ...base, humanSeat: 1, result: win, siteElo: 1000 })
    expect(r.after).toBeLessThan(r.before)
  })

  test('a preview level has no site Elo: a labelled provisional opponent rating is used', async () => {
    const r = await applyRating(db, { ...base, level: 'hard', result: win, siteElo: null })
    expect(r.provisional).toBe(true)
    expect(r.after).toBeGreaterThan(START_ELO + 20) // beating a 1400 level pays more than a 1000 one
    expect(PROVISIONAL_LEVEL_ELO.hard).toBeGreaterThan(PROVISIONAL_LEVEL_ELO.easy)
  })
})

function playFour(matchId: string, seed: number, level: MatchRecordV1['agent']['level'] = 'easy'): MatchRecordV1 {
  const rng = makeRng(seed ^ 0x9e37)
  let s = fourCore.init(seed)
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
    schema: 1, matchId, game: 'four', coreVersion: fourCore.version,
    agent: { version: 'v1', level }, seed, humanSeat: 0, actions,
    result: fourCore.result(s)!, finalHash: fourCore.hash(s),
    startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}

const opts = { agentVersion: () => 'v1', side: () => 0 as const, siteElo: () => null as number | null }

async function playOne(who: { userId?: string; guestId?: string }, tamper?: (r: MatchRecordV1) => void) {
  const s = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, who, opts)
  const { matchId, seed } = s.body as { matchId: string; seed: number }
  const rec = playFour(matchId, seed)
  tamper?.(rec)
  return { matchId, rec, res: await finishMatchHandler(db, encodeRecord(rec), who, opts) }
}

describe('finishing a match rates it', () => {
  test('a valid match by a signed-in user returns the rating change', async () => {
    const { res, rec } = await playOne(USER)
    const body = res.body as { valid: boolean; elo?: { before: number; after: number }; provisional?: boolean }
    expect(body.valid).toBe(true)
    expect(body.elo!.before).toBe(START_ELO)
    expect(body.provisional).toBe(true)
    const humanWon = rec.result.winner === 0
    const draw = rec.result.winner === null
    if (draw) expect(body.elo!.after).toBeLessThan(START_ELO + 1)
    else expect(body.elo!.after > START_ELO).toBe(humanWon)
    expect((await db.select().from(schema.rating))[0]!.games).toBe(1)
  })

  test('an invalid record does not rate', async () => {
    const { res } = await playOne(USER, (r) => {
      r.result = { winner: r.result.winner === 0 ? 1 : 0, score: [0, 0], reason: 'x' }
    })
    expect((res.body as { valid: boolean }).valid).toBe(false)
    expect((await db.select().from(schema.rating)).length).toBe(0)
  })

  test('a guest gets no rating', async () => {
    await db.insert(schema.guest).values({ id: 'g-1' })
    const { res } = await playOne({ guestId: 'g-1' })
    expect((res.body as { elo?: unknown }).elo).toBeUndefined()
    expect((await db.select().from(schema.rating)).length).toBe(0)
  })

  test('an abandoned match is scored once as a loss and cannot be finished later', async () => {
    const s = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, USER, opts)
    const { matchId, seed } = s.body as { matchId: string; seed: number }
    await db.update(schema.match).set({ startedAt: new Date(Date.now() - 3 * 3600 * 1000) }).where(eq(schema.match.id, matchId))
    expect(await abandonStale(db)).toBe(1)
    const r = await finishMatchHandler(db, encodeRecord(playFour(matchId, seed)), USER, opts)
    expect(r.status).toBe(409)
    const rows = await db.select().from(schema.rating)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ games: 1 })
    expect(rows[0]!.elo).toBeLessThan(START_ELO)
  })

  test('a measured level uses its registry Elo and is not provisional', async () => {
    const s = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, USER, opts)
    const { matchId, seed } = s.body as { matchId: string; seed: number }
    const r = await finishMatchHandler(db, encodeRecord(playFour(matchId, seed)), USER, { ...opts, siteElo: () => 1100 })
    expect((r.body as { provisional?: boolean }).provisional).toBe(false)
  })
})

describe('leaderboard', () => {
  test('needs MIN_GAMES (5) games and sorts by Elo', async () => {
    expect(MIN_GAMES).toBe(5)
    await db.insert(schema.user).values([
      { id: 'a', name: 'Ada Lovelace', email: 'a@x.test' },
      { id: 'b', name: 'Bo', email: 'b@x.test' },
      { id: 'c', name: 'Cy', email: 'c@x.test' },
    ])
    await db.insert(schema.rating).values([
      { userId: 'a', game: 'four', elo: 1100, games: 5 },
      { userId: 'b', game: 'four', elo: 1300, games: 12 },
      { userId: 'c', game: 'four', elo: 1900, games: 4 },
      { userId: 'a', game: 'word', elo: 2000, games: 50 },
    ])
    const rows = await getLeaderboard(db, 'four')
    expect(rows.map((r) => r.name)).toEqual(['Bo', 'Ada'])
    expect(rows.map((r) => r.rank)).toEqual([1, 2])
    expect(rows[0]).toMatchObject({ elo: 1300, games: 12 })
  })

  test('shows no email', async () => {
    await db.insert(schema.user).values({ id: 'a', name: 'Ada', email: 'secret@x.test' })
    await db.insert(schema.rating).values({ userId: 'a', game: 'four', elo: 1100, games: 6 })
    expect(JSON.stringify(await getLeaderboard(db, 'four'))).not.toContain('secret@x.test')
  })
})

test('realtime games carry no chained site Elo, so their ratings stay provisional; turn games keep it', () => {
  expect(ratedSiteElo('fighter', 2958.88)).toBeNull()
  expect(ratedSiteElo('arena', 1500)).toBeNull()
  expect(ratedSiteElo('chess', 1174)).toBe(1174)
  expect(ratedSiteElo('four', undefined)).toBeNull()
})
