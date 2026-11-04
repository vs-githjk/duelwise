import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { holdemCore, type HoldemAction } from '@duelwise/core/src/games/holdem/core'
import type { MatchOptions } from '@duelwise/core/src/games/holdem/match'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { makeRng } from '@duelwise/core/src/rng'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finish } from './finish-unchecked'
import { abandonStale } from './abandon'
import { resignMatchHandler } from './resign'
import { getPath } from './path'
import { finishedResults } from './results'
import { getBoard, getMyRecord } from './landing'
import { getGameStats, trainingEligible } from './stats'
import { getReport } from './report'

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

const USER = { userId: 'u-1' }
const GUEST = { guestId: 'g-1' }
const since = new Date(Date.now() - 86_400_000)

/** A Hold'em match where whoever acts folds, played under the given options. */
function playHoldem(matchId: string, seed: number, options: MatchOptions | undefined): MatchRecordV1 {
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

function playFour(matchId: string, seed: number): MatchRecordV1 {
  const rng = makeRng(seed ^ 0x9e37)
  let s = fourCore.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  while (!fourCore.terminal(s)) {
    const seat = fourCore.toAct(s)[0]!
    const legal = fourCore.legal(s, seat)
    const a = legal[rng.int(legal.length)]!
    actions.push([tick++, seat, fourCore.encodeAction(a)])
    s = fourCore.step(s, seat === 0 ? [a, null] : [null, a])
  }
  return {
    schema: 1, matchId, game: 'four', coreVersion: fourCore.version,
    agent: { version: 'v1', level: 'easy' }, seed, humanSeat: 0, actions,
    result: fourCore.result(s)!, finalHash: fourCore.hash(s),
    startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}

const startOpts = { agentVersion: () => 'v1', side: () => 0 as const }
const startHoldem = (who: { userId?: string; guestId?: string }, extra: Record<string, unknown>) =>
  startMatchHandler(db, { sides: 1, game: 'holdem', level: 'easy', ...extra }, who, startOpts)
const startFour = (who: { userId?: string; guestId?: string }, extra: Record<string, unknown> = {}) =>
  startMatchHandler(db, { sides: 1, game: 'four', level: 'easy', ...extra }, who, startOpts)
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
/** Makes a finished match's stored result a human win, so only the practice marker can keep it off a competitive read. */
const makeWin = (id: string) => db.update(schema.match).set({ result: { winner: 0, score: [1, 0], reason: 'ahead' } }).where(eq(schema.match.id, id))

describe('the server decides that a match is practice, at the start', () => {
  test('a practice start writes the flag, and a Hold\'em practice match has no bust ending', async () => {
    const r = await startHoldem(USER, { options: { hands: 5, untilBust: true }, practice: true })
    expect(r.status).toBe(200)
    const row = await rowOf((r.body as { matchId: string }).matchId)
    expect(row.filterFlags).toEqual({ holdemOptions: { hands: 5 }, practice: true })
  })

  test('a start without practice writes no flag, and a rated Hold\'em match keeps the strict bust rule', async () => {
    const r = await startHoldem(USER, { options: { hands: 5 } })
    const row = await rowOf((r.body as { matchId: string }).matchId)
    expect(row.filterFlags).toEqual({ holdemOptions: { hands: 5, untilBust: true } })
    const f = await startFour(USER)
    expect((await rowOf((f.body as { matchId: string }).matchId)).filterFlags).toEqual({ humanSeat: 0 })
  })

  test('practice must be a real boolean', async () => {
    expect((await startFour(USER, { practice: 'yes' })).status).toBe(400)
    expect((await startFour(USER, { practice: 1 })).status).toBe(400)
    expect((await startFour(USER, { practice: false })).status).toBe(200)
  })

  test('a record cannot turn a practice match into a rated one, or the reverse', async () => {
    const p = await startHoldem(USER, { options: { hands: 5 }, practice: true })
    const { matchId, seed } = p.body as { matchId: string; seed: number }
    // Claiming the strict bust rule that a rated match has.
    const out = await finish(db, encodeRecord(playHoldem(matchId, seed, { hands: 5, untilBust: true })), USER)
    expect(out.body).toMatchObject({ valid: false })
    expect((await rowOf(matchId)).filterFlags).toMatchObject({ practice: true })

    // A rated start whose record claims the no-bust rule of a practice match.
    const q = await startHoldem(USER, { options: { hands: 5 } })
    const b = q.body as { matchId: string; seed: number }
    const out2 = await finish(db, encodeRecord(playHoldem(b.matchId, b.seed, { hands: 5 })), USER)
    expect(out2.body).toMatchObject({ valid: false })
    expect((await db.select().from(schema.rating)).length).toBe(0)
  })
})

describe('a practice match moves no competitive read', () => {
  test('control: the same match, rated, is a rating, a path clear, a board result and a weekly win', async () => {
    const r = await startHoldem(USER, { options: { hands: 5 } })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const out = await finish(db, encodeRecord(playHoldem(matchId, seed, { hands: 5, untilBust: true })), USER)
    expect(out.body).toMatchObject({ valid: true })
    expect((out.body as { elo?: unknown }).elo).toBeDefined()
    await makeWin(matchId)
    expect((await getPath(db, USER, 'holdem')).easy).toBe(true)
    expect(await finishedResults(db, { game: 'holdem', since })).toHaveLength(1)
    expect((await getBoard(db)).matches).toBeGreaterThan(0)
    expect((await getMyRecord(db, 'u-1')).recent.length).toBe(1)
    expect((await getGameStats(db, 'holdem')).weekly.at(-1)!.levels.easy?.wins).toBe(1)
  })

  test('a Hold\'em practice win: no rating, no clear, no board result, no profile row, no landing tally, no weekly win; still played and trainable', async () => {
    const r = await startHoldem(USER, { options: { hands: 5 }, practice: true })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const out = await finish(db, encodeRecord(playHoldem(matchId, seed, { hands: 5 })), USER)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ valid: true, unranked: true, practice: true })
    expect((out.body as { elo?: unknown }).elo).toBeUndefined()
    await makeWin(matchId)

    const row = await rowOf(matchId)
    expect(row).toMatchObject({ status: 'finished', recordValid: true, trainingAllowed: true })
    expect(row.filterFlags).toMatchObject({ practice: true })
    expect(trainingEligible(row)).toBe(true)

    expect((await db.select().from(schema.rating)).length).toBe(0)
    expect((await getPath(db, USER, 'holdem')).easy).toBe(false)
    expect(await finishedResults(db, { game: 'holdem', since })).toHaveLength(0)
    expect((await getBoard(db)).matches).toBe(0)
    expect((await getBoard(db)).latest).toHaveLength(0)
    expect((await getMyRecord(db, 'u-1')).recent).toHaveLength(0)
    const stats = await getGameStats(db, 'holdem')
    expect(stats.weekly.at(-1)!.levels.easy?.wins ?? 0).toBe(0)
    expect(stats.funnel.played).toBe(1)
    expect(stats.funnel.finished).toBe(1)
    expect(stats.funnel.allowed).toBe(1)
    expect(stats.funnel.reasons.practice).toBeUndefined()
  })

  test('a practice match in another game (Four in a Row), as a guest, is also unrated and counts nowhere', async () => {
    const r = await startFour(GUEST, { practice: true })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const out = await finish(db, encodeRecord(playFour(matchId, seed)), GUEST)
    expect(out.body).toMatchObject({ valid: true, unranked: true, practice: true })
    await makeWin(matchId)
    expect((await getPath(db, GUEST, 'four')).easy).toBe(false)
    expect(await finishedResults(db, { game: 'four', since })).toHaveLength(0)
    expect((await getGameStats(db, 'four')).funnel.played).toBe(1)
  })

  test('the report page does not count a practice match in the record against the level', async () => {
    const rated = await startFour(USER)
    const a = rated.body as { matchId: string; seed: number }
    await finish(db, encodeRecord(playFour(a.matchId, a.seed)), USER)
    await makeWin(a.matchId)
    const prac = await startFour(USER, { practice: true })
    const b = prac.body as { matchId: string; seed: number }
    await finish(db, encodeRecord(playFour(b.matchId, b.seed)), USER)
    await makeWin(b.matchId)
    const view = await getReport(db, a.matchId, { userId: 'u-1' })
    const vs = view && 'vs' in view ? (view as { vs?: { wins: number; losses: number; draws: number } }).vs : undefined
    if (vs) expect(vs.wins + vs.losses + vs.draws).toBe(1)
  })

  test('resigning a practice match costs no rating and keeps the marker', async () => {
    const r = await startFour(USER, { practice: true })
    const { matchId } = r.body as { matchId: string }
    const out = await resignMatchHandler(db, { matchId, tick: 3 }, USER)
    expect(out.body).toEqual({ resigned: true })
    expect((await rowOf(matchId)).filterFlags).toMatchObject({ resigned: true, practice: true })
    expect((await db.select().from(schema.rating)).length).toBe(0)
    expect((await getMyRecord(db, 'u-1')).recent).toHaveLength(0)
  })

  test('walking away from a practice match costs no rating and keeps the marker, while a rated one is charged', async () => {
    const p = await startFour(USER, { practice: true })
    const q = await startFour(USER)
    await db.update(schema.match).set({ startedAt: new Date(Date.now() - 5 * 3_600_000) })
    expect(await abandonStale(db, new Date(), { siteElo: () => 1200 })).toBe(2)
    const pid = (p.body as { matchId: string }).matchId
    const qid = (q.body as { matchId: string }).matchId
    expect((await rowOf(pid)).filterFlags).toMatchObject({ abandoned: true, practice: true })
    expect((await rowOf(qid)).filterFlags).toEqual({ abandoned: true })
    const ratings = await db.select().from(schema.rating)
    expect(ratings).toHaveLength(1)
    expect((await getMyRecord(db, 'u-1')).recent).toHaveLength(1)
  })

  test('a practice match left early is both: unrated and marked left', async () => {
    const r = await startHoldem(USER, { options: { hands: 10 }, practice: true })
    const { matchId, seed } = r.body as { matchId: string; seed: number }
    const out = await finish(db, encodeRecord(playHoldem(matchId, seed, { hands: 10, leftAfter: 4 })), USER)
    expect(out.body).toMatchObject({ valid: true, unranked: true, practice: true })
    expect((await rowOf(matchId)).filterFlags).toMatchObject({ practice: true, leftTable: true })
  })
})
