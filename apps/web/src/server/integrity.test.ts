import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { ABANDON_GRACE_MS, abandonStale, MAX_MATCH_MS } from './abandon'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { encodeRecord } from '@duelwise/core/src/match-record'
import { resignMatchHandler } from './resign'
import { applyRating, START_ELO } from './ratings'
import { leaderboardViewHandler } from './leaderboard'
import { listTrainingMatches } from './training-export'

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
const NOW = new Date('2026-10-21T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

async function seedMatch(id: string, over: Partial<typeof schema.match.$inferInsert> = {}) {
  await db.insert(schema.match).values({ id, game: 'four', userId: 'u-1', agentVersion: 'v1', level: 'easy', seed: 1, status: 'started', ...over })
}
const ratingOf = async () => (await db.select().from(schema.rating).where(eq(schema.rating.userId, 'u-1')))[0]
const lossFromStart = async (): Promise<number> => {
  const r = await applyRating(db, { userId: 'probe', game: 'four', level: 'easy', humanSeat: 0, result: { winner: 1, score: [0, 1], reason: 'x' }, siteElo: null })
  return r.after - r.before
}

describe('abandoned rated matches', () => {
  test('a started rated match with no finish is a loss once the game max duration plus grace has passed', async () => {
    const limit = MAX_MATCH_MS.four + ABANDON_GRACE_MS
    await seedMatch('late', { startedAt: ago(limit + 60_000) })
    await seedMatch('within', { startedAt: ago(limit - 60_000) })
    expect(await abandonStale(db, NOW)).toBe(1)
    const rows = Object.fromEntries((await db.select().from(schema.match)).map((r) => [r.id, r]))
    expect(rows.late!.status).toBe('abandoned')
    expect(rows.late!.trainingAllowed).toBe(false)
    expect(rows.within!.status).toBe('started')
    const r = await ratingOf()
    expect(r!.games).toBe(1)
    expect(r!.elo - START_ELO).toBe(await lossFromStart())
  })

  test('is scored once: a second sweep does not charge the loss again', async () => {
    await seedMatch('late', { startedAt: ago(MAX_MATCH_MS.four + ABANDON_GRACE_MS + 1000) })
    await abandonStale(db, NOW)
    expect(await abandonStale(db, NOW)).toBe(0)
    expect((await ratingOf())!.games).toBe(1)
  })

  test('each game has its own limit', async () => {
    const age = MAX_MATCH_MS.four + ABANDON_GRACE_MS + 1000
    expect(MAX_MATCH_MS.chess).toBeGreaterThan(MAX_MATCH_MS.four)
    await seedMatch('four-late', { startedAt: ago(age) })
    await seedMatch('chess-ok', { game: 'chess', startedAt: ago(age) })
    await abandonStale(db, NOW)
    const rows = Object.fromEntries((await db.select().from(schema.match)).map((r) => [r.id, r.status]))
    expect(rows).toEqual({ 'four-late': 'abandoned', 'chess-ok': 'started' })
  })

  test('a guest match is abandoned without a rating; finished matches are untouched', async () => {
    await db.insert(schema.guest).values({ id: 'g-1' })
    const age = MAX_MATCH_MS.four + ABANDON_GRACE_MS + 1000
    await seedMatch('guest', { userId: null, guestId: 'g-1', startedAt: ago(age) })
    await seedMatch('done', { status: 'finished', startedAt: ago(age) })
    expect(await abandonStale(db, NOW)).toBe(1)
    expect(await ratingOf()).toBeUndefined()
  })
})

describe('resign', () => {
  async function started(who: { userId?: string; guestId?: string } = USER) {
    const r = await startMatchHandler(db, { game: 'four', level: 'easy' }, who, { agentVersion: () => 'v1' })
    return (r.body as { matchId: string }).matchId
  }

  test('costs Elo exactly like a loss and records the resign tick', async () => {
    const id = await started()
    const r = await resignMatchHandler(db, { matchId: id, tick: 7 }, USER)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ resigned: true, elo: { before: START_ELO } })
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
    expect(row.status).toBe('resigned')
    expect(row.filterFlags).toEqual({ resigned: true, resignTick: 7 })
    expect(row.trainingAllowed).toBe(false)
    expect(row.finishedAt).not.toBeNull()
    expect((await ratingOf())!.elo - START_ELO).toBe(await lossFromStart())
    expect((await ratingOf())!.games).toBe(1)
  })

  test('resigning twice, or another player resigning your match, changes nothing', async () => {
    const id = await started()
    expect((await resignMatchHandler(db, { matchId: id, tick: 1 }, { userId: 'u-2' })).status).toBe(403)
    expect((await resignMatchHandler(db, { matchId: id, tick: 1 }, USER)).status).toBe(200)
    expect((await resignMatchHandler(db, { matchId: id, tick: 2 }, USER)).status).toBe(409)
    expect((await ratingOf())!.games).toBe(1)
  })

  test('rejects bad input and unknown matches', async () => {
    expect((await resignMatchHandler(db, null, USER)).status).toBe(400)
    expect((await resignMatchHandler(db, { matchId: 5 }, USER)).status).toBe(400)
    expect((await resignMatchHandler(db, { matchId: 'nope', tick: 0 }, USER)).status).toBe(404)
    expect((await resignMatchHandler(db, { matchId: 'x', tick: 0 }, {})).status).toBe(401)
  })

  test('a guest resign is recorded but never rated', async () => {
    await db.insert(schema.guest).values({ id: 'g-1' })
    const id = await started({ guestId: 'g-1' } as never)
    const r = await resignMatchHandler(db, { matchId: id, tick: 3 }, { guestId: 'g-1' })
    expect(r.status).toBe(200)
    expect((r.body as { elo?: unknown }).elo).toBeUndefined()
    expect(await ratingOf()).toBeUndefined()
  })

  test('a finished match cannot be resigned', async () => {
    await seedMatch('done', { status: 'finished' })
    expect((await resignMatchHandler(db, { matchId: 'done', tick: 1 }, USER)).status).toBe(409)
  })
})

describe('abandon sweep robustness and wiring', () => {
  test('one failing rating does not strand the other abandoned rows', async () => {
    const old = ago(MAX_MATCH_MS.four + ABANDON_GRACE_MS + 1000)
    await seedMatch('a', { startedAt: old, userId: null })
    await seedMatch('b', { startedAt: old })
    await seedMatch('c', { startedAt: old })
    const real = console.error
    console.error = () => {}
    try {
      // Rating the first row throws; the second and third must still be rated.
      let calls = 0
      const flaky = new Proxy(db, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv)
          if (prop === 'insert') {
            return (...args: unknown[]) => {
              if (calls++ === 0) throw new Error('transient')
              return (v as (...a: unknown[]) => unknown).apply(target, args)
            }
          }
          return typeof v === 'function' ? v.bind(target) : v
        },
      }) as Db
      await abandonStale(flaky, NOW)
    } finally {
      console.error = real
    }
    const rows = await db.select().from(schema.match)
    expect(rows.every((r) => r.status === 'abandoned')).toBe(true)
    expect((await ratingOf())!.games).toBeGreaterThanOrEqual(1)
  })

  test('the leaderboard read sweeps stale matches first', async () => {
    await seedMatch('late', { startedAt: ago(MAX_MATCH_MS.four + ABANDON_GRACE_MS + 1000) })
    expect(await ratingOf()).toBeUndefined()
    const view = await leaderboardViewHandler(db, 'four', 'u-1', NOW, async (d, now) => {
      await abandonStale(d, now)
    })
    expect(view.me?.games).toBe(1)
    expect((await ratingOf())!.games).toBe(1)
  })
})

describe('leaderboard view signedIn', () => {
  test('a signed-in user with no rating row is signedIn with me null; anonymous is not', async () => {
    const noop = async () => {}
    const a = await leaderboardViewHandler(db, 'four', 'u-1', NOW, noop)
    expect(a.signedIn).toBe(true)
    expect(a.me).toBeNull()
    const b = await leaderboardViewHandler(db, 'four', null, NOW, noop)
    expect(b.signedIn).toBe(false)
  })
})

describe('training export', () => {
  test('resigned and abandoned matches never enter it', async () => {
    const rec = new Uint8Array([1, 2, 3])
    const ok = { status: 'finished' as const, recordValid: true, record: rec, trainingAllowed: true }
    await seedMatch('good', ok)
    await seedMatch('resigned', { ...ok, status: 'resigned', filterFlags: { resigned: true, resignTick: 2 } })
    await seedMatch('abandoned', { ...ok, status: 'abandoned' })
    await seedMatch('flagged-resign', { ...ok, filterFlags: { resigned: true } })
    await seedMatch('opted-out', { ...ok, trainingAllowed: false })
    await seedMatch('invalid', { ...ok, recordValid: false })
    const rows = await listTrainingMatches(db, 'four')
    expect(rows.map((r) => r.id)).toEqual(['good'])
  })
})

describe('a finished match whose client replay failed', () => {
  test('uploading it settles the row unrated, so the abandon sweep never charges a loss', async () => {
    await seedMatch('bad', { startedAt: ago(MAX_MATCH_MS.four + ABANDON_GRACE_MS + 60_000) })
    const bytes = encodeRecord({
      schema: 1, matchId: 'bad', game: 'four', coreVersion: 'x', agent: { version: 'v1', level: 'easy' }, seed: 1, humanSeat: 0,
      actions: [], result: { winner: 0, score: [1, 0], reason: 'x' }, finalHash: '0123456789abcdef',
      startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: true,
    })
    const r = await finishMatchHandler(db, bytes, USER)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ valid: false })
    expect(await abandonStale(db, NOW)).toBe(0)
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, 'bad')))[0]!
    expect(row.status).toBe('finished')
    expect(await ratingOf()).toBeUndefined()
  })
})
