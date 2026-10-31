import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { getBoard } from './landing'
import { getGameStats } from './stats'
import { finishedResults } from './results'
import { getLevelBoard, getOpponentRecords } from './board'
import { getLeaderboard, MIN_GAMES } from './leaderboard'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, rating, guest, "user" cascade`)
})

const NOW = new Date('2026-10-30T12:00:00.000Z')
let n = 0

interface Put {
  id: string
  guestId?: string
  userId?: string
  traffic?: 'human' | 'owner' | 'test' | null
  game?: GameId
  level?: Level
  /** Whether the human won. */
  win?: boolean
}

async function put(f: Put) {
  const game = f.game ?? 'four'
  const level = f.level ?? 'hard'
  const when = new Date(NOW.getTime() - 3_600_000)
  const result = { winner: (f.win === false ? 1 : 0) as 0 | 1, score: [1, 0] as [number, number], reason: 'fixture' }
  const record = encodeRecord({
    schema: 1, matchId: f.id, game, coreVersion: '1', agent: { version: 'v1', level }, seed: ++n, humanSeat: 0, actions: [],
    result, finalHash: '0123456789abcdef', startedAt: when.toISOString(), endedAt: when.toISOString(), device: 'desktop', input: 'mouse', trainingAllowed: true,
  })
  await db.insert(schema.match).values({
    id: f.id, game, guestId: f.userId ? null : (f.guestId ?? 'g-real'), userId: f.userId ?? null, agentVersion: 'v1', level, seed: n, status: 'finished',
    result, record, recordValid: true, trainingAllowed: true, startedAt: when, finishedAt: when, traffic: f.traffic ?? null,
  })
}

describe('public numbers leave Test traffic out and keep owner games in', () => {
  test('the landing board, weekly stats, the latest feed and the persona records ignore a test-tagged match', async () => {
    await put({ id: 'real-1', win: true })
    await put({ id: 'real-2', win: false })
    await put({ id: 'owner-1', guestId: 'g-owner', traffic: 'owner', win: true })
    await put({ id: 'test-1', guestId: 'g-test', traffic: 'test', win: true })
    await put({ id: 'test-2', guestId: 'g-test', traffic: 'test', win: true })
    const board = await getBoard(db, NOW)
    expect(board.matches).toBe(3)
    expect(board.humanWins).toBe(2)
    expect(board.latest.map((r) => r.id).sort()).toEqual(['owner-1', 'real-1', 'real-2'])
    const stats = await getGameStats(db, 'four', NOW, 1)
    expect(stats.funnel.played).toBe(3)
    expect(stats.counted).toBe(3)
    const rec = (await getOpponentRecords(db, NOW)).find((r) => r.level === 'hard')!
    expect([rec.wins, rec.losses]).toEqual([1, 2])
  })

  test('a test-tagged match never appears, even when its player has no guest row, and a real player keeps the rest of their games', async () => {
    await db.insert(schema.guest).values([{ id: 'g-real', traffic: 'human' }, { id: 'g-test', traffic: 'test' }])
    await put({ id: 'a', win: true })
    await put({ id: 'b', guestId: 'g-test', traffic: 'test', win: true })
    await put({ id: 'c', guestId: 'g-real', traffic: 'test', win: true })
    const all = await finishedResults(db, { since: new Date(NOW.getTime() - 30 * 86_400_000) })
    expect(all.map((r) => r.id)).toEqual(['a'])
  })

  test('the level board and its player count do not include a test player', async () => {
    await db.insert(schema.guest).values([{ id: 'g-real', traffic: 'human', displayName: 'Wren' }, { id: 'g-test', traffic: 'test', displayName: 'Bot' }])
    await put({ id: 'a', win: true })
    await put({ id: 'b', guestId: 'g-test', traffic: 'test', win: true })
    const lb = await getLevelBoard(db, 'four', {}, new Set(), NOW)
    const col = lb.columns.find((c) => c.level === 'hard')!
    expect(col.players).toBe(1)
    expect(col.rows.map((r) => r.name)).toEqual(['Wren'])
  })

  test('a test account is not on the rating board', async () => {
    await db.insert(schema.user).values([
      { id: 'u-real', name: 'Ada Real', email: 'ada@example.com' },
      { id: 'u-test', name: 'Bot Tester', email: 'bot@example.com' },
    ])
    await db.insert(schema.rating).values([
      { userId: 'u-real', game: 'four', elo: 1400, games: MIN_GAMES },
      { userId: 'u-test', game: 'four', elo: 1900, games: MIN_GAMES },
    ])
    await put({ id: 't1', userId: 'u-test', traffic: 'test', win: true })
    expect((await getLeaderboard(db, 'four')).map((r) => r.name)).toEqual(['Ada'])
  })
})
