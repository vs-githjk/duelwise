import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { holdemCore, type HoldemAction } from '@duelwise/core/src/games/holdem/core'
import type { MatchOptions } from '@duelwise/core/src/games/holdem/match'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finish } from './finish-unchecked'

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
  await db.insert(schema.guest).values({ id: 'g-1' })
  await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
})

const GUEST = { guestId: 'g-1' }
const USER = { userId: 'u-1' }

/** Plays a Hold'em match where whoever acts folds, under the given options, as the record a client would upload. */
function play(matchId: string, seed: number, options: MatchOptions | undefined): MatchRecordV1 {
  let s = holdemCore.init(seed, options)
  const actions: MatchRecordV1['actions'] = []
  const fold: HoldemAction = { type: 'fold' }
  let tick = 0
  while (!holdemCore.terminal(s)) {
    actions.push([tick++, s.actor, holdemCore.encodeAction(fold)])
    const a: [HoldemAction | null, HoldemAction | null] = [null, null]
    a[s.actor] = fold
    s = holdemCore.step(s, a)
  }
  return {
    schema: 1, matchId, game: 'holdem', coreVersion: holdemCore.version,
    agent: { version: 'v1', level: 'easy' }, seed, humanSeat: 0, actions,
    result: holdemCore.result(s)!, finalHash: holdemCore.hash(s),
    startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:01:00.000Z',
    device: 'phone', input: 'touch', trainingAllowed: true,
    ...(options ? { options } : {}),
  }
}

async function begin(who: { guestId?: string; userId?: string }, options?: unknown) {
  return startMatchHandler(db, { game: 'holdem', level: 'easy', ...(options !== undefined ? { options } : {}) }, who, { agentVersion: () => 'v1' })
}

describe("Hold'em match length on the server", () => {
  test('a chosen length is stored at the start and a record of that length is accepted', async () => {
    const r = await begin(GUEST, { hands: 5 })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!
    expect((row.filterFlags as { holdemOptions: unknown }).holdemOptions).toEqual({ hands: 5, untilBust: true })
    const out = await finish(db, encodeRecord(play(matchId, seed, { hands: 5, untilBust: true })), GUEST)
    expect(out.body).toMatchObject({ valid: true })
  })

  test('a record that claims a length the player did not choose is rejected', async () => {
    const r = await begin(GUEST, { hands: 5 })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const out = await finish(db, encodeRecord(play(matchId, seed, { hands: 10, untilBust: true })), GUEST)
    expect(out.body).toMatchObject({ valid: false })
    expect((out.body as { reason: string }).reason).toMatch(/does not match the one chosen at the start/)
  })

  test('a default 30 hand start rejects a short record, and a short start rejects a default or non-strict record', async () => {
    const a = await begin(GUEST, { untilBust: true })
    const ra = a.body as { matchId: string; seed: number }
    const bad = await finish(db, encodeRecord(play(ra.matchId, ra.seed, { hands: 5, untilBust: true })), GUEST)
    expect((bad.body as { valid: boolean }).valid).toBe(false)
    const b = await begin(GUEST, { hands: 10 })
    const rb = b.body as { matchId: string; seed: number }
    const bad2 = await finish(db, encodeRecord(play(rb.matchId, rb.seed, undefined)), GUEST)
    expect((bad2.body as { valid: boolean }).valid).toBe(false)
    // The strict bust rule is the server's choice, not the client's: a record that leaves it off does not match.
    const bad3 = await finish(db, encodeRecord(play(rb.matchId, rb.seed, { hands: 10 })), GUEST)
    expect((bad3.body as { valid: boolean }).valid).toBe(false)
  })

  test('an old client that sends no options gets the legacy match: 30 hands, no bust rule, accepted and rated as before', async () => {
    const r = await begin(USER)
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!
    expect((row.filterFlags as { holdemOptions?: unknown } | null)?.holdemOptions).toBeUndefined()
    const out = await finish(db, encodeRecord(play(matchId, seed, undefined)), USER)
    expect(out.body).toMatchObject({ valid: true })
    expect((out.body as { elo?: unknown }).elo).toBeDefined()
    // A record that claims the strict rule for a legacy start is the one that differs, and is invalid.
    const r2 = await begin(GUEST)
    const m2 = r2.body as { matchId: string; seed: number }
    const bad = await finish(db, encodeRecord(play(m2.matchId, m2.seed, { untilBust: true })), GUEST)
    expect((bad.body as { valid: boolean }).valid).toBe(false)
  })

  test('the start refuses unknown lengths, odd options, options for other games and a leave claimed up front', async () => {
    expect((await begin(GUEST, { hands: 7 })).status).toBe(400)
    expect((await begin(GUEST, { untilBust: 'yes' })).status).toBe(400)
    expect((await begin(GUEST, { hands: 10, leftAfter: 3 })).status).toBe(400)
    expect((await startMatchHandler(db, { game: 'chess', level: 'easy', options: { hands: 5 } }, GUEST, {})).status).toBe(400)
  })

  test('leaving early is valid and trainable but moves no rating', async () => {
    const r = await begin(USER, { hands: 10 })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const out = await finish(db, encodeRecord(play(matchId, seed, { hands: 10, untilBust: true, leftAfter: 4 })), USER)
    expect(out.body).toMatchObject({ valid: true, unranked: true, left: true })
    expect((out.body as { elo?: unknown }).elo).toBeUndefined()
    expect((await db.select().from(schema.rating)).length).toBe(0)
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!
    expect(row.recordValid).toBe(true)
    expect(row.trainingAllowed).toBe(true)
  })

  test('finishing the chosen length is rated as before', async () => {
    const r = await begin(USER, { hands: 5 })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const out = await finish(db, encodeRecord(play(matchId, seed, { hands: 5, untilBust: true })), USER)
    expect(out.body).toMatchObject({ valid: true })
    expect((out.body as { left?: boolean }).left).toBeUndefined()
    expect((await db.select().from(schema.rating)).length).toBe(1)
  })

  test('a leave claimed beyond the chosen end is not a record at all', async () => {
    const r = await begin(USER, { hands: 5 })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const rec = play(matchId, seed, { hands: 5, untilBust: true })
    expect(() => encodeRecord({ ...rec, options: { hands: 5, untilBust: true, leftAfter: 5 } })).toThrow(/leftAfter/)
  })
})
