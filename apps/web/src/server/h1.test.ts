import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import type { GameId } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { abandonStale, MAX_OPEN_MATCHES, sweepOpenOverCap } from './abandon'
import { CHECK_CLAIM_MS, checkAgentMoves } from './agent-check'
import { fakeAgent, play } from './agent-check-fixtures'
import { finishMatchHandler, startMatchHandler, type FinishOptions } from './match-handlers'
import { resignMatchHandler } from './resign'

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
/** The production shape of the check, with the fake opponent standing in for the shipped one. */
const CHECKED: FinishOptions = { verifyAgent: (rec) => checkAgentMoves(rec, { makeAgent: async (g) => fakeAgent(g) }) }

async function begin(game: GameId, who: { userId?: string; guestId?: string } = USER, seed = 21) {
  const r = await startMatchHandler(db, { sides: 1, game, level: 'hard' }, who, { seed: () => seed, side: () => 0 as const })
  expect(r.status).toBe(200)
  return r.body as { matchId: string; seed: number }
}
const ratingOf = async (game: GameId) => (await db.select().from(schema.rating).where(and(eq(schema.rating.userId, 'u-1'), eq(schema.rating.game, game))))[0]

for (const game of ['chess', 'four', 'holdem', 'slack'] as const) {
  describe(`${game}: finishing a counted match (H1)`, () => {
    test('an honest record is valid, rates the player, stays trainable and is stored', async () => {
      const m = await begin(game)
      const rec = await play(game, m.seed, undefined, 'hard', m.matchId)
      const r = await finishMatchHandler(db, encodeRecord(rec), USER, CHECKED)
      expect(r.body).toMatchObject({ valid: true })
      expect((r.body as { elo?: unknown }).elo).toBeDefined()
      expect((await ratingOf(game))?.games).toBe(1)
      const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
      expect(row).toMatchObject({ status: 'finished', recordValid: true, trainingAllowed: true })
      expect(row.record).not.toBeNull()
    })

    test('a forged record (the agent plays a legal blunder) is rejected: no rating, not trainable, no stored bytes', async () => {
      const m = await begin(game)
      const rec = await play(game, m.seed, 1, 'hard', m.matchId)
      const r = await finishMatchHandler(db, encodeRecord(rec), USER, CHECKED)
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ valid: false })
      expect((r.body as { reason: string }).reason).toContain('not the ones the opponent plays')
      expect((r.body as { elo?: unknown }).elo).toBeUndefined()
      expect(await ratingOf(game)).toBeUndefined()
      const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
      expect(row).toMatchObject({ status: 'finished', recordValid: false, trainingAllowed: false, record: null })
      expect(row.invalidReason).toContain('opponent')
    })

    test('with no server check configured the match is not counted (fail closed)', async () => {
      const m = await begin(game)
      const rec = await play(game, m.seed, undefined, 'hard', m.matchId)
      const r = await finishMatchHandler(db, encodeRecord(rec), USER)
      expect(r.body).toMatchObject({ valid: false })
      expect((r.body as { reason: string }).reason).toContain('could not be checked')
      expect(await ratingOf(game)).toBeUndefined()
    })

    test('a check that ran out of time leaves the match unrated, never valid', async () => {
      const m = await begin(game)
      const rec = await play(game, m.seed, undefined, 'hard', m.matchId)
      let t = 0
      const slow: FinishOptions = { verifyAgent: (r) => checkAgentMoves(r, { makeAgent: async (g) => fakeAgent(g), budgetMs: 10, now: () => (t += 50) }) }
      const r = await finishMatchHandler(db, encodeRecord(rec), USER, slow)
      expect(r.body).toMatchObject({ valid: false })
      expect((r.body as { reason: string }).reason).toContain('ran out of time')
      expect(await ratingOf(game)).toBeUndefined()
    })
  })
}

describe('one check per match at a time', () => {
  test('5 concurrent finishes run the agent check once; the rest answer 503 (the client keeps and retries)', async () => {
    const m = await begin('four')
    const bytes = encodeRecord(await play('four', m.seed, undefined, 'hard', m.matchId))
    let checks = 0
    const opts: FinishOptions = { verifyAgent: async () => { checks++; await new Promise((r) => setTimeout(r, 100)); return { kind: 'verified' } } }
    const outs = await Promise.all(Array.from({ length: 5 }, () => finishMatchHandler(db, bytes, USER, opts)))
    expect(checks).toBe(1)
    expect(outs.map((o) => o.status).sort()).toEqual([200, 503, 503, 503, 503])
  })

  test('a check that died can be retried after the window, not before', async () => {
    const m = await begin('four')
    const bytes = encodeRecord(await play('four', m.seed, undefined, 'hard', m.matchId))
    let checks = 0
    const dies: FinishOptions = { verifyAgent: async () => { checks++; throw new Error('function killed') } }
    await expect(finishMatchHandler(db, bytes, USER, dies)).rejects.toThrow('function killed')
    const ok: FinishOptions = { verifyAgent: async () => { checks++; return { kind: 'verified' } } }
    expect((await finishMatchHandler(db, bytes, USER, ok)).status).toBe(503)
    expect(checks).toBe(1)
    await db.execute(sql`update match set filter_flags = jsonb_build_object('checkStartedAt', ${Date.now() - CHECK_CLAIM_MS - 1000}::bigint) where id = ${m.matchId}`)
    const r = await finishMatchHandler(db, bytes, USER, ok)
    expect(r.status).toBe(200)
    expect(checks).toBe(2)
  })
})

describe('an unverified check is logged', () => {
  test('agent check lines reach console.warn so an operator can see the check cannot run', async () => {
    const m = await begin('four')
    const bytes = encodeRecord(await play('four', m.seed, undefined, 'hard', m.matchId))
    const seen: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => { seen.push(a.join(' ')) }
    try {
      const r = await finishMatchHandler(db, bytes, USER, { verifyAgent: async () => ({ kind: 'unverified', reason: 'model file missing' }) })
      expect(r.status).toBe(200)
    } finally {
      console.warn = orig
    }
    expect(seen).toContain('agent check unverified: model file missing')
  })
})

describe('real-time games never rate', () => {
  async function realtimeRecord(game: 'fighter' | 'arena', matchId: string, seed: number): Promise<MatchRecordV1> {
    const core = getCore(game)
    let s = core.init(seed)
    while (!core.terminal(s)) s = core.step(s, [null, null])
    return {
      schema: 1, matchId, game, coreVersion: core.version, agent: { version: 'v1', level: 'hard' }, seed, humanSeat: 0, actions: [],
      result: core.result(s)!, finalHash: core.hash(s), startedAt: '2026-10-23T10:00:00.000Z', endedAt: '2026-10-23T10:01:00.000Z',
      device: 'desktop', input: 'keyboard', trainingAllowed: true,
    }
  }

  for (const game of ['fighter', 'arena'] as const) {
    test(`${game}: a finished match is stored and valid, changes no rating, and the reply says it is unranked`, async () => {
      const m = await begin(game)
      const r = await finishMatchHandler(db, encodeRecord(await realtimeRecord(game, m.matchId, m.seed)), USER, CHECKED)
      expect(r.body).toMatchObject({ valid: true, unranked: true })
      expect((r.body as { elo?: unknown }).elo).toBeUndefined()
      expect(await ratingOf(game)).toBeUndefined()
      expect((await db.select().from(schema.matchReport)).length).toBe(0)
    })

    test(`${game}: resigning and abandoning change no rating either`, async () => {
      const a = await begin(game)
      const r = await resignMatchHandler(db, { matchId: a.matchId, tick: 5 }, USER)
      expect(r.body).toEqual({ resigned: true })
      const b = await begin(game)
      await db.update(schema.match).set({ startedAt: new Date('2026-01-01T00:00:00Z') }).where(eq(schema.match.id, b.matchId))
      expect(await abandonStale(db, new Date('2026-10-23T00:00:00Z'))).toBe(1)
      expect(await ratingOf(game)).toBeUndefined()
    })
  }

  test('a turn game still rates on resign (the loss is real)', async () => {
    const a = await begin('four')
    const r = await resignMatchHandler(db, { matchId: a.matchId, tick: 3 }, USER)
    expect((r.body as { elo?: unknown }).elo).toBeDefined()
    expect((await ratingOf('four'))?.games).toBe(1)
  })
})

describe('write caps (M2)', () => {
  test('a rejected record is not stored, and neither is one that fails replay', async () => {
    const m = await begin('four')
    const rec = await play('four', m.seed, undefined, 'hard', m.matchId)
    const broken = { ...rec, finalHash: '0000000000000000' }
    const r = await finishMatchHandler(db, encodeRecord(broken), USER, CHECKED)
    expect(r.body).toMatchObject({ valid: false })
    expect((await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!.record).toBeNull()
  })

  test('a fourth start sweeps the oldest open match as abandoned, so at most 3 stay open', async () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_OPEN_MATCHES + 2; i++) {
      ids.push((await begin('four', USER, 100 + i)).matchId)
      // Distinct start times keep "oldest" unambiguous.
      await db.update(schema.match).set({ startedAt: new Date(Date.UTC(2026, 9, 23, 10, i)) }).where(eq(schema.match.id, ids[i]!))
    }
    const rows = await db.select().from(schema.match)
    const open = rows.filter((r) => r.status === 'started').map((r) => r.id)
    expect(open.length).toBeLessThanOrEqual(MAX_OPEN_MATCHES)
    const swept = rows.filter((r) => r.status === 'abandoned')
    expect(swept.length).toBeGreaterThanOrEqual(2)
    // The newest ones survive; the oldest are the swept ones.
    expect(open).toContain(ids[ids.length - 1]!)
    expect(swept.map((r) => r.id)).toContain(ids[0]!)
    expect(swept.every((r) => r.trainingAllowed === false && r.invalidReason === 'abandoned')).toBe(true)
    // The signed-in player is charged the abandon loss for each, like the stale sweep.
    expect((await ratingOf('four'))?.games).toBe(swept.length)
  })

  test('the cap is per player: another player and a guest are not swept', async () => {
    await db.insert(schema.guest).values({ id: 'g-1' })
    for (let i = 0; i < 3; i++) await begin('four', USER, 200 + i)
    await begin('four', { userId: 'u-2' }, 300)
    await begin('four', { guestId: 'g-1' }, 301)
    expect(await sweepOpenOverCap(db, { userId: 'u-2' })).toBe(0)
    expect(await sweepOpenOverCap(db, { guestId: 'g-1' })).toBe(0)
    expect((await db.select().from(schema.match).where(eq(schema.match.status, 'started'))).length).toBe(5)
  })

  test('a guest is capped too, and a guest loss touches no rating', async () => {
    await db.insert(schema.guest).values({ id: 'g-2' })
    for (let i = 0; i < 6; i++) await begin('four', { guestId: 'g-2' }, 400 + i)
    const open = (await db.select().from(schema.match).where(and(eq(schema.match.guestId, 'g-2'), eq(schema.match.status, 'started')))).length
    expect(open).toBeLessThanOrEqual(MAX_OPEN_MATCHES)
    expect((await db.select().from(schema.rating)).length).toBe(0)
  })
})
