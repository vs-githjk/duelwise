import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordsTrainable } from '../lib/honest-copy'
import { getBoard, getBoardCached, getMyRecord } from './landing'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, rating`)
})

const NOW = new Date('2026-10-21T12:00:00.000Z')
const at = (days: number, hours = 0) => new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000)
let n = 0

interface Fixture {
  id?: string
  game?: GameId
  level?: Level
  outcome?: 'human' | 'agent' | 'draw'
  humanSeat?: 0 | 1
  valid?: boolean
  undecodable?: boolean
  when?: Date
  userId?: string | null
}

async function put(f: Fixture = {}) {
  const id = f.id ?? `m-${++n}`
  const game = f.game ?? 'four'
  const level = f.level ?? 'hard'
  const humanSeat = f.humanSeat ?? 0
  const winner = f.outcome === 'draw' ? null : (f.outcome ?? 'human') === 'human' ? humanSeat : ((1 - humanSeat) as 0 | 1)
  const result = { winner, score: [1, 0] as [number, number], reason: 'fixture' }
  const when = f.when ?? at(1)
  const record = f.undecodable
    ? new Uint8Array([1, 2, 3])
    : encodeRecord({
        schema: 1, matchId: id, game, coreVersion: '1', agent: { version: 'v1', level }, seed: n, humanSeat, actions: [],
        result, finalHash: '0123456789abcdef', startedAt: when.toISOString(), endedAt: when.toISOString(), device: 'desktop', input: 'mouse', trainingAllowed: true,
      })
  await db.insert(schema.match).values({
    id, game, guestId: 'g', userId: f.userId ?? null, agentVersion: 'v1', level, seed: n, status: 'finished',
    result, record, recordValid: f.valid ?? true, invalidReason: f.valid === false ? 'replay failed' : null,
    trainingAllowed: true, startedAt: when, finishedAt: when,
  })
}

describe('getBoard', () => {
  test('pending checks are excluded from the board and player totals', async () => {
    await put({ id: 'pending', userId: 'u' })
    await db.execute(sql`update match set filter_flags = '{"deferredCheckAt":1}'::jsonb where id = 'pending'`)
    const board = await getBoard(db, NOW)
    expect(board.matches).toBe(0)
    expect(board.latest).toEqual([])
    expect((await getMyRecord(db, 'u')).perGame).toEqual([])
  })
  test('counts valid matches in the last 7 days, from the human side, per game', async () => {
    await put({ id: 'a-human-seat1', humanSeat: 1, outcome: 'human', when: at(1, 5) })
    await put({ id: 'b-ai', outcome: 'agent', when: at(1, 4) })
    await put({ id: 'c-draw', outcome: 'draw', when: at(1, 3) })
    await put({ id: 'd-invalid', valid: false, outcome: 'human', when: at(1, 2) })
    await put({ id: 'e-old', outcome: 'human', when: at(8) })
    await put({ id: 'f-undecodable', undecodable: true, when: at(1, 1) })
    await put({ id: 'g-fighter', game: 'fighter', outcome: 'human', when: at(2) })

    const b = await getBoard(db, NOW)
    // valid and in window: a, b, c, g (stats count f too; only the latest feed needs a readable record)
    const four = b.perGame.find((g) => g.game === 'four')!
    const fighter = b.perGame.find((g) => g.game === 'fighter')!
    expect(four).toEqual({ game: 'four', games: 3, wins: 1 })
    expect(fighter).toEqual({ game: 'fighter', games: 1, wins: 1 })
    expect(b.matches).toBe(4)
    expect(b.humanWins).toBe(2)
    for (const g of b.perGame) if (g.game !== 'four' && g.game !== 'fighter') expect(g.games).toBe(0)
  })

  test('latest lists newest first with the right outcome, skips unreadable records, and honours the limit', async () => {
    await put({ id: 'a-human-seat1', humanSeat: 1, outcome: 'human', when: at(1, 5) })
    await put({ id: 'b-ai', outcome: 'agent', when: at(1, 4) })
    await put({ id: 'c-draw', outcome: 'draw', when: at(1, 3) })
    await put({ id: 'd-invalid', valid: false, outcome: 'human', when: at(1, 2) })
    await put({ id: 'f-undecodable', undecodable: true, when: at(1, 1) })
    await put({ id: 'e-old', outcome: 'agent', when: at(8) })

    const b = await getBoard(db, NOW)
    expect(b.latest.map((r) => [r.id, r.outcome])).toEqual([
      ['c-draw', 'draw'],
      ['b-ai', 'ai'],
      ['a-human-seat1', 'human'],
      ['e-old', 'ai'],
    ])
    const limited = await getBoard(db, NOW, 2)
    expect(limited.latest.map((r) => r.id)).toEqual(['c-draw', 'b-ai'])
  })

  test('is empty when there are no matches', async () => {
    const b = await getBoard(db, NOW)
    expect(b.matches).toBe(0)
    expect(b.humanWins).toBe(0)
    expect(b.latest).toEqual([])
  })
})

describe('getBoardCached', () => {
  test('serves the aggregates from memory inside the TTL and re-reads after it', async () => {
    const t0 = NOW.getTime()
    const first = await getBoardCached(db, t0, 60_000)
    expect(first.matches).toBe(0)
    await put({ id: 'cache-a', outcome: 'human', when: at(1) })
    expect(await getBoardCached(db, t0 + 59_000, 60_000)).toBe(first)
    const later = await getBoardCached(db, t0 + 61_000, 60_000)
    expect(later).not.toBe(first)
    expect(later.matches).toBe(1)
    expect(later.humanWins).toBe(1)
  })
})

describe('getMyRecord', () => {
  test('returns only that user\'s ratings and valid matches', async () => {
    await db.insert(schema.rating).values([
      { userId: 'u1', game: 'four', elo: 1210, games: 7 },
      { userId: 'u2', game: 'four', elo: 900, games: 2 },
    ])
    await put({ id: 'mine-win', userId: 'u1', outcome: 'human', when: at(1, 3) })
    await put({ id: 'mine-loss', userId: 'u1', outcome: 'agent', when: at(1, 2) })
    await put({ id: 'mine-rejected', userId: 'u1', outcome: 'human', valid: false, when: at(1, 1) })
    await put({ id: 'theirs', userId: 'u2', outcome: 'human', when: at(1) })
    await put({ id: 'guest', userId: null, outcome: 'human', when: at(1) })

    const r = await getMyRecord(db, 'u1')
    expect(r.ratings).toEqual([{ game: 'four', elo: 1210, games: 7 }])
    expect(r.recent.map((x) => [x.id, x.outcome])).toEqual([
      ['mine-rejected', null],
      ['mine-loss', 'ai'],
      ['mine-win', 'human'],
    ])
    expect((await getMyRecord(db, 'u1', 1)).recent.map((x) => x.id)).toEqual(['mine-rejected'])
  })

  test('a resigned or abandoned match counts as a loss in totals, win rate, streak and recent', async () => {
    await put({ id: 'win', userId: 'u1', outcome: 'human', when: at(1, 3) })
    await db.insert(schema.match).values({
      id: 'gave-up', game: 'four', guestId: 'g', userId: 'u1', agentVersion: 'v1', level: 'hard', seed: 1, status: 'resigned',
      trainingAllowed: false, invalidReason: 'resigned', filterFlags: { resigned: true, resignTick: 3 }, startedAt: at(1, 2), finishedAt: at(1, 1),
    })
    const r = await getMyRecord(db, 'u1')
    const four = r.perGame.find((g) => g.game === 'four')!
    expect(four.total).toBe(2)
    expect(four.won).toBe(1)
    expect(four.winRate).toBe(50)
    expect(four.streak).toBe(0)
    expect(four.lastOutcome).toBe('ai')
    expect(r.recent.map((x) => [x.id, x.outcome])).toEqual([
      ['gave-up', 'ai'],
      ['win', 'human'],
    ])
    await db.execute(sql`update match set status = 'abandoned' where id = 'gave-up'`)
    expect((await getMyRecord(db, 'u1')).perGame[0]!.total).toBe(2)
  })

  test('learning status: counts, stats only, and rejected rows show a reason and no result', async () => {
    await put({ id: 'ok', userId: 'u1', when: at(1, 4) })
    await put({ id: 'opt-out', userId: 'u1', when: at(1, 3) })
    await db.execute(sql`update match set training_allowed = false where id = 'opt-out'`)
    await put({ id: 'flagged', userId: 'u1', when: at(1, 2) })
    await db.execute(sql`update match set filter_flags = '{"too_short": true}'::jsonb where id = 'flagged'`)
    await put({ id: 'bad', userId: 'u1', valid: false, when: at(1, 1) })
    const r = await getMyRecord(db, 'u1', 10)
    expect(r.recent.map((x) => [x.id, x.outcome, x.learning])).toEqual([
      ['bad', null, 'Rejected: replay failed'],
      ['flagged', 'human', 'Stats only'],
      ['opt-out', 'human', 'Stats only'],
      ['ok', 'human', 'Eligible for training'],
    ])
    // a rejected match is not in any tally
    expect(r.perGame.find((g) => g.game === 'four')!.total).toBe(3)
  })

  test('a game that does not learn from humans reads Stats only', async () => {
    await put({ id: 'ok', userId: 'u1', when: at(1, 1) })
    const r = await getMyRecord(db, 'u1', 5, NOW, (g) => g !== 'four')
    expect(r.recent.map((x) => [x.id, x.learning])).toEqual([['ok', 'Stats only']])
  })

  test('the learning label follows the registry rule: a registry that does not learn reads Stats only, Four reads Eligible', async () => {
    const reg = (g: string) => JSON.parse(readFileSync(join(import.meta.dir, `../../../../packages/agents/registry/${g}.json`), 'utf8'))
    const rule = (g: GameId) => recordsTrainable(g, reg(g))
    await put({ id: 'f', userId: 'u1', game: 'four', when: at(1, 1) })
    await put({ id: 'c', userId: 'u1', game: 'chess', when: at(1, 2) })
    await put({ id: 'w', userId: 'u1', game: 'word', when: at(1, 3) })
    const r = await getMyRecord(db, 'u1', 5, NOW, rule)
    expect(r.recent.map((x) => [x.id, x.learning])).toEqual([['f', 'Eligible for training'], ['c', 'Stats only'], ['w', 'Stats only']])
  })

  test('reports the window when the player has more matches than the totals cover', async () => {
    await put({ id: 'w1', userId: 'u1', when: at(1) })
    expect((await getMyRecord(db, 'u1', 5, NOW)).window).toBeNull()
  })

  test('per-game record: won of total, win rate, streak, best level and next challenge', async () => {
    await put({ id: 's1', userId: 'u1', level: 'easy', outcome: 'human', when: at(5) })
    await put({ id: 's2', userId: 'u1', level: 'hard', outcome: 'agent', when: at(4) })
    await put({ id: 's3', userId: 'u1', level: 'medium', outcome: 'human', when: at(3) })
    await put({ id: 's4', userId: 'u1', level: 'medium', outcome: 'draw', when: at(2) })
    await put({ id: 's5', userId: 'u1', level: 'hard', outcome: 'human', when: at(1, 2) })
    await put({ id: 's6', userId: 'u1', level: 'easy', outcome: 'human', when: at(1, 1) })
    await put({ id: 'f1', userId: 'u1', game: 'fighter', level: 'easy', outcome: 'agent', when: at(8) })
    const r = await getMyRecord(db, 'u1', 5, NOW)
    expect(r.perGame.find((g) => g.game === 'four')).toEqual({
      game: 'four', won: 4, total: 6, winRate: 67, streak: 2, best: 'hard', beaten: ['easy', 'medium', 'hard'], next: 'champion', lastOutcome: 'human',
    })
    expect(r.perGame.find((g) => g.game === 'fighter')).toMatchObject({ won: 0, total: 1, winRate: 0, streak: 0, best: null, next: 'easy', lastOutcome: 'ai' })
    expect(r.perGame.find((g) => g.game === 'chess')).toBeUndefined()
    // four was played most recently
    expect(r.nextChallenge).toEqual({ game: 'four', level: 'champion' })
  })

  test('activity holds the finish time of valid matches from the last 8 days only', async () => {
    await put({ id: 'd0a', userId: 'u1', when: at(0, 1) })
    await put({ id: 'd0b', userId: 'u1', when: at(0, 2) })
    await put({ id: 'd2', userId: 'u1', when: at(2) })
    await put({ id: 'd6', userId: 'u1', when: at(6) })
    await put({ id: 'd7', userId: 'u1', when: at(7) })
    await put({ id: 'd9', userId: 'u1', when: at(9) })
    await put({ id: 'dbad', userId: 'u1', valid: false, when: at(1) })
    const r = await getMyRecord(db, 'u1', 5, NOW)
    expect(r.activity.sort()).toEqual([at(7), at(6), at(2), at(0, 2), at(0, 1)].map((d) => d.toISOString()).sort())
  })

  test('no next challenge when every level is beaten, and none for a player with no matches', async () => {
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) await put({ id: `b-${level}`, userId: 'u1', level, when: at(1) })
    expect((await getMyRecord(db, 'u1', 5, NOW)).nextChallenge).toBeNull()
    const empty = await getMyRecord(db, 'nobody', 5, NOW)
    expect(empty.nextChallenge).toBeNull()
    expect(empty.perGame).toEqual([])
    expect(empty.activity).toEqual([])
  })
})

describe('record reads', () => {
  test('a second board read does not download a record again, and a rewritten record is read afresh', async () => {
    const { seatStats } = await import('./record-seats')
    await put({ id: 'seat-a', humanSeat: 0, outcome: 'human', when: at(1) })
    await put({ id: 'seat-b', humanSeat: 1, outcome: 'human', when: at(2) })
    seatStats.fetched = 0
    const first = await getBoard(db, NOW)
    expect(seatStats.fetched).toBe(2)
    const second = await getBoard(db, NOW)
    expect(seatStats.fetched).toBe(2)
    expect(second).toEqual(first)
    expect(second.humanWins).toBe(2)
    // Same id, other seat and a different finish time: the memo must not answer for it.
    await db.execute(sql`delete from match where id = 'seat-a'`)
    await put({ id: 'seat-a', humanSeat: 1, outcome: 'agent', when: at(3) })
    const third = await getBoard(db, NOW)
    expect(seatStats.fetched).toBe(3)
    expect(third.humanWins).toBe(1)
  })
})
