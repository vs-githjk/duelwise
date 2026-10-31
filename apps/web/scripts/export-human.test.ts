import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { holdemCore, type HoldemAction, type HoldemState } from '@duelwise/core/src/games/holdem/core'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { Seat } from '@duelwise/core/src/types'
import { migrateDb } from '../src/db/migrate'
import * as schema from '../src/db/schema'
import { exportHuman, matchWeight, playerKey, type HumanRow, type Query } from './export-human'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

const FOUR = [3, 3, 2, 4, 3, 2, 4, 1, 3, 5, 0, 6]
function fourRecord(id: string, seed: number, over: Partial<MatchRecordV1> = {}): MatchRecordV1 {
  return {
    schema: 1, matchId: id, game: 'four', coreVersion: '1', agent: { version: 'v1', level: 'hard' }, seed, humanSeat: 0,
    actions: FOUR.map((c, i) => [i, (i % 2) as Seat, c] as [number, Seat, number]),
    humanInputTimesMs: [820, 1310, 640, 2200, 905, 1500], result: { winner: 0, score: [1, 0], reason: 'four' }, finalHash: '0123456789abcdef',
    startedAt: '2026-10-30T08:00:00.000Z', endedAt: '2026-10-30T08:03:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: true, ...over,
  }
}
function chessRecord(id: string, seed: number, humanMoves = 10): MatchRecordV1 {
  const actions: MatchRecordV1['actions'] = []
  for (let i = 0; i < humanMoves * 2; i++) actions.push([i, (i % 2) as Seat, 800 + ((seed * 7 + i * 13) % 2000)])
  return {
    schema: 1, matchId: id, game: 'chess', coreVersion: '1', agent: { version: 'v1', level: 'hard' }, seed, humanSeat: 0, actions,
    result: { winner: 0, score: [1, 0], reason: 'checkmate' }, finalHash: '0123456789abcdef', startedAt: '2026-10-30T08:00:00.000Z',
    endedAt: '2026-10-30T08:30:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}
function holdemRecord(id: string, seed: number, hands = 5, fold = false): MatchRecordV1 {
  // fold: the opponent raises to 6 whenever it can and the human folds to every raise.
  let s: HoldemState = holdemCore.init(seed, { hands })
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  while (!holdemCore.terminal(s)) {
    const seat = s.actor
    const toCall = Math.max(s.bet[0], s.bet[1]) - s.bet[seat]
    const a: HoldemAction =
      fold && seat === 0 && toCall > 0 ? { type: 'fold' } : fold && seat === 1 && s.street === 0 && s.bet[1] < 6 && s.canRaise[1] ? { type: 'raise', to: 6 } : { type: 'call' }
    actions.push([tick++, seat, holdemCore.encodeAction(a)])
    s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
  }
  const result = holdemCore.result(s)!
  return {
    schema: 1, matchId: id, game: 'holdem', coreVersion: 'holdem-1', agent: { version: 'v1', level: 'champion' }, seed, humanSeat: 0, actions, result,
    finalHash: '0123456789abcdef', startedAt: '2026-10-30T08:00:00.000Z', endedAt: '2026-10-30T08:10:00.000Z', device: 'phone', input: 'touch',
    trainingAllowed: true, options: { hands },
  }
}

async function freshDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrateDb(db)
  let n = 0
  const add = (id: string, rec: MatchRecordV1 | null, over: Partial<typeof schema.match.$inferInsert> = {}) =>
    db.insert(schema.match).values({
      id, game: rec?.game ?? 'four', guestId: 'g-default', agentVersion: 'v1', level: 'hard', seed: rec?.seed ?? 1, status: 'finished', recordValid: true,
      trainingAllowed: true, traffic: 'human', record: rec ? encodeRecord(rec) : null,
      startedAt: new Date(Date.parse('2026-10-30T08:00:00Z') + 1000 * n++), finishedAt: new Date(), ...over,
    })
  const log: string[] = []
  const query: Query = async (text, params) => {
    log.push(text.trim().split(/\s+/)[0]!.toLowerCase())
    const r = await client.query<Record<string, unknown>>(text, params as never)
    return r.rows
  }
  return { client, db, add, query, log }
}

async function out(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'duelwise-human-'))
  dirs.push(d)
  return d
}
const readRows = async (dir: string, game: string, file = 'matches.jsonl'): Promise<HumanRow[]> =>
  (await readFile(join(dir, game, file), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))

describe('export-human filters', () => {
  test('keeps human and owner traffic, never test, and drops untagged rows unless asked', async () => {
    const t = await freshDb()
    await t.add('h1', fourRecord('h1', 1), { traffic: 'human' })
    await t.add('o1', fourRecord('o1', 2), { traffic: 'owner', guestId: 'g-owner' })
    await t.add('t1', fourRecord('t1', 3), { traffic: 'test', guestId: 'g-test' })
    await t.add('n1', fourRecord('n1', 4), { traffic: null, guestId: 'g-null' })
    const dir = await out()
    const s = await exportHuman({ game: 'four', query: t.query, outDir: dir, holdoutPercent: 0 })
    expect(s.total).toBe(4)
    expect((await readRows(dir, 'four')).map((r) => r.id).sort()).toEqual(['h1', 'o1'])
    expect(s.rejected).toEqual({ traffic_test: 1, traffic_untagged: 1 })
    const dir2 = await out()
    await exportHuman({ game: 'four', query: t.query, outDir: dir2, holdoutPercent: 0, includeUntagged: true })
    expect((await readRows(dir2, 'four')).map((r) => r.id).sort()).toEqual(['h1', 'n1', 'o1'])
  }, 120000)

  test('practice and left-table matches are dropped by default and kept, flagged, on request', async () => {
    const t = await freshDb()
    await t.add('real', fourRecord('real', 1))
    await t.add('prac', fourRecord('prac', 2), { filterFlags: { practice: true } })
    await t.add('left', fourRecord('left', 3), { filterFlags: { leftTable: true } })
    const dir = await out()
    const s = await exportHuman({ game: 'four', query: t.query, outDir: dir, holdoutPercent: 0 })
    expect((await readRows(dir, 'four')).map((r) => r.id)).toEqual(['real'])
    expect(s.rejected).toEqual({ practice: 1, left_table: 1 })
    const dir2 = await out()
    await exportHuman({ game: 'four', query: t.query, outDir: dir2, holdoutPercent: 0, includePractice: true, includeLeft: true })
    const rows = await readRows(dir2, 'four')
    expect(rows.find((r) => r.id === 'prac')!.practice).toBe(true)
    expect(rows.find((r) => r.id === 'left')!.left).toBe(true)
    expect(rows.find((r) => r.id === 'real')!.practice).toBe(false)
  }, 120000)

  test('the training filters still apply: unfinished, invalid replay, no consent, synthetic ids, duplicates, too short, inhuman timing', async () => {
    const t = await freshDb()
    await t.add('ok', fourRecord('ok', 1))
    await t.add('dup', fourRecord('dup', 1))
    await t.add('bad', fourRecord('bad', 2), { recordValid: false })
    await t.add('open', null, { status: 'started', recordValid: null })
    await t.add('nope', fourRecord('nope', 3, { trainingAllowed: false }), { trainingAllowed: false })
    await t.add('test-99', fourRecord('test-99', 4))
    await t.add('short', fourRecord('short', 5, { actions: [[0, 0, 3], [1, 1, 3], [2, 0, 2]], humanInputTimesMs: [500, 600] }))
    await t.add('fast', fourRecord('fast', 6, { humanInputTimesMs: [20, 30, 25, 28, 22, 21] }))
    const dir = await out()
    const s = await exportHuman({ game: 'four', query: t.query, outDir: dir, holdoutPercent: 0 })
    expect((await readRows(dir, 'four')).map((r) => r.id)).toEqual(['ok'])
    expect(s.rejected).toEqual({ duplicate: 1, replay_invalid: 1, unfinished: 1, training_not_allowed: 1, synthetic: 1, too_short: 1, inhuman_timing: 1 })
  }, 120000)

  test('chess rows carry UCI moves and need 8 human moves; Hold\'em needs 3 hands and a player who does not fold every one', async () => {
    const t = await freshDb()
    await t.add('c-ok', chessRecord('c-ok', 1))
    await t.add('c-short', chessRecord('c-short', 2, 4))
    const dir = await out()
    const s = await exportHuman({ game: 'chess', query: t.query, outDir: dir, holdoutPercent: 0 })
    const rows = await readRows(dir, 'chess')
    expect(rows.map((r) => r.id)).toEqual(['c-ok'])
    expect(rows[0]!.moves!.length).toBe(20)
    expect(typeof rows[0]!.moves![0]).toBe('string')
    expect(s.rejected).toEqual({ too_short: 1 })

    const h = await freshDb()
    await h.add('p-ok', holdemRecord('p-ok', 21))
    await h.add('p-fold', holdemRecord('p-fold', 22, 5, true))
    await h.add('p-two', holdemRecord('p-two', 23, 5), { record: encodeRecord({ ...holdemRecord('p-two', 23), actions: holdemRecord('p-two', 23).actions.slice(0, 5) }) })
    const dir2 = await out()
    const s2 = await exportHuman({ game: 'holdem', query: h.query, outDir: dir2, holdoutPercent: 0 })
    expect((await readRows(dir2, 'holdem')).map((r) => r.id)).toEqual(['p-ok'])
    expect(s2.rejected.inhuman_timing).toBe(1)
    expect(s2.rejected.too_short).toBe(1)
  }, 120000)
})

describe('export-human caps, weights and holdout', () => {
  test('keeps at most 20 matches per player per day, the heaviest first, and a new day starts again', async () => {
    const t = await freshDb()
    // 24 matches by one guest on one day: 4 against easy (weight 0), 10 hard wins, 10 champion losses.
    for (let i = 0; i < 24; i++) {
      const level = i < 4 ? 'easy' : i < 14 ? 'hard' : 'champion'
      const winner = i < 14 ? 0 : 1
      await t.add(`d${i}`, fourRecord(`d${i}`, 100 + i, { result: { winner: winner as Seat, score: winner === 0 ? [1, 0] : [0, 1], reason: 'four' } }), { level, guestId: 'g-busy' })
    }
    // the same guest the next day, and another guest the same day
    await t.add('next-day', fourRecord('next-day', 200), { guestId: 'g-busy', startedAt: new Date('2026-10-31T08:00:00Z') })
    await t.add('other', fourRecord('other', 201), { guestId: 'g-other' })
    const dir = await out()
    const s = await exportHuman({ game: 'four', query: t.query, outDir: dir, holdoutPercent: 0 })
    const rows = await readRows(dir, 'four')
    const busy = rows.filter((r) => r.player === playerKey(null, 'g-busy') && r.day === '2026-10-30')
    expect(busy.length).toBe(20)
    expect(s.rejected.daily_cap).toBe(4)
    // the four dropped are the four weight-0 easy matches
    expect(busy.filter((r) => r.level === 'easy').length).toBe(0)
    expect(rows.some((r) => r.id === 'next-day')).toBe(true)
    expect(rows.some((r) => r.id === 'other')).toBe(true)
    expect(s.kept).toBe(22)
  }, 120000)

  test('the 2 percent share cap applies once there are 50 players, and not before', async () => {
    const t = await freshDb()
    for (let i = 0; i < 59; i++) await t.add(`s${i}`, fourRecord(`s${i}`, 300 + i), { guestId: `g-${i}` })
    for (let i = 0; i < 12; i++) await t.add(`heavy${i}`, fourRecord(`heavy${i}`, 400 + i), { guestId: 'g-heavy' })
    const dir = await out()
    const s = await exportHuman({ game: 'four', query: t.query, outDir: dir, holdoutPercent: 0 })
    // 60 players, 71 kept before the cap: floor(71 * 0.02) = 1 per player
    expect(s.kept).toBe(60)
    expect(s.rejected.share_cap).toBe(11)

    const few = await freshDb()
    for (let i = 0; i < 12; i++) await few.add(`f${i}`, fourRecord(`f${i}`, 500 + i), { guestId: 'g-solo' })
    const s2 = await exportHuman({ game: 'four', query: few.query, outDir: await out(), holdoutPercent: 0 })
    expect(s2.kept).toBe(12)
    expect(s2.rejected.share_cap).toBeUndefined()
  }, 120000)

  test('weights: wins and draws against Hard and Champion count most, Easy counts nothing, a rating nudges within 25 percent', () => {
    expect(matchWeight('champion', 'win', null)).toBe(2)
    expect(matchWeight('hard', 'win', null)).toBe(1)
    expect(matchWeight('champion', 'draw', null)).toBe(1.2)
    expect(matchWeight('hard', 'loss', null)).toBe(0.15)
    expect(matchWeight('medium', 'win', null)).toBe(0.25)
    expect(matchWeight('easy', 'win', null)).toBe(0)
    expect(matchWeight('hard', 'win', 3000)).toBe(1.25)
    expect(matchWeight('hard', 'win', 0)).toBe(0.75)
    expect(matchWeight('champion', 'win', null)).toBeGreaterThan(matchWeight('hard', 'win', null))
    expect(matchWeight('hard', 'win', null)).toBeGreaterThan(matchWeight('hard', 'loss', null))
  }, 120000)

  test('the holdout is a stable share by id hash, never in the training file, and Four starts follow the weights', async () => {
    const t = await freshDb()
    for (let i = 0; i < 60; i++) await t.add(`ho${i}`, fourRecord(`ho${i}`, 600 + i), { guestId: `g-ho${i}`, level: i % 2 ? 'champion' : 'easy' })
    const a = await out()
    const b = await out()
    const s1 = await exportHuman({ game: 'four', query: t.query, outDir: a, holdoutPercent: 20 })
    const s2 = await exportHuman({ game: 'four', query: t.query, outDir: b, holdoutPercent: 20 })
    expect(s1.holdout).toBe(s2.holdout)
    expect(s1.holdout).toBeGreaterThan(0)
    expect(s1.training + s1.holdout).toBe(60)
    const train = new Set((await readRows(a, 'four')).map((r) => r.id))
    const hold = (await readRows(a, 'four', 'holdout.jsonl')).map((r) => r.id)
    expect(hold.every((id) => !train.has(id))).toBe(true)
    expect(s1.idsSha256).toBe(s2.idsSha256)
    const starts = JSON.parse(await readFile(join(a, 'four', 'starts.json'), 'utf8'))
    const trainRows = await readRows(a, 'four')
    // each champion win (weight 2, no rating) is written 4 times per position; easy matches (weight 0) write none
    const perMatch = FOUR.length - 1 - 4
    expect(starts.positions.length).toBe(trainRows.filter((r) => r.level === 'champion').length * perMatch * 4)
  }, 120000)

  test('the output holds no raw player id, only the opaque key', async () => {
    const t = await freshDb()
    await t.add('x1', fourRecord('x1', 1), { guestId: 'guest-secret-id' })
    const dir = await out()
    await exportHuman({ game: 'four', query: t.query, outDir: dir, holdoutPercent: 0 })
    const text = await readFile(join(dir, 'four', 'matches.jsonl'), 'utf8')
    expect(text.includes('guest-secret-id')).toBe(false)
    expect(text.includes(playerKey(null, 'guest-secret-id'))).toBe(true)
    expect(playerKey(null, 'a')).not.toBe(playerKey('a', null))
  }, 120000)

  test('it only ever issues select statements and leaves the database unchanged', async () => {
    const t = await freshDb()
    await t.add('r1', fourRecord('r1', 1))
    const before = (await t.client.query<{ n: number }>('select count(*)::int as n from match')).rows[0]!.n
    await exportHuman({ game: 'four', query: t.query, outDir: await out(), holdoutPercent: 0 })
    const after = (await t.client.query<{ n: number }>('select count(*)::int as n from match')).rows[0]!.n
    expect(after).toBe(before)
    expect(new Set(t.log)).toEqual(new Set(['select']))
  }, 120000)

  test('the poker profile opt-out is read from profile and guest rows, and absent games are an error', async () => {
    const t = await freshDb()
    await t.db.insert(schema.profile).values({ userId: 'u-out', pokerProfileAllowed: false })
    await t.add('p1', holdemRecord('p1', 31), { userId: 'u-out', guestId: null })
    await t.db.insert(schema.guest).values({ id: 'g-out', pokerProfileAllowed: false })
    await t.add('p2', holdemRecord('p2', 32), { guestId: 'g-out' })
    await t.add('p3', holdemRecord('p3', 33), { guestId: 'g-in' })
    const dir = await out()
    const s = await exportHuman({ game: 'holdem', query: t.query, outDir: dir, holdoutPercent: 0 })
    expect(s.pokerOptOutColumn).toBe(true)
    const rows = await readRows(dir, 'holdem')
    expect(Object.fromEntries(rows.map((r) => [r.id, r.profileOk]))).toEqual({ p1: false, p2: false, p3: true })
    await expect(exportHuman({ game: 'word', query: t.query, outDir: dir })).rejects.toThrow()
  }, 120000)
})
