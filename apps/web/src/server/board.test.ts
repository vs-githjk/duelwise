import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { getLevelBoard, getOpponentRecords, getOpponentRecordsCached } from './board'
import { getPath } from './path'
import { getIdentity, saveName, setGuestBoardVisibility } from './identity'
import { startMatchHandler } from './match-handlers'
import { resolveGuest } from './guest'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, guest, profile`)
})

const NOW = new Date('2026-10-30T12:00:00.000Z')
const days = (d: number, h = 0) => new Date(NOW.getTime() - d * 86_400_000 - h * 3_600_000)
let n = 0
const GID = (c: string) => `${c.repeat(8)}-1111-2222-3333-${c.repeat(12)}`

async function guest(id: string, name?: string, show = true) {
  await db.insert(schema.guest).values({ id, displayName: name ?? null, showOnLeaderboard: show })
}

interface Put {
  who: string
  level?: Level
  game?: GameId
  win?: boolean
  moves?: number
  when?: Date
  seat?: 0 | 1
  userId?: string
}
async function put(f: Put) {
  const id = `m-${++n}`
  const game = f.game ?? 'word'
  const level = f.level ?? 'easy'
  const seat = f.seat ?? 0
  const winner = f.win === false ? ((1 - seat) as 0 | 1) : seat
  const result = { winner, score: [1, 0] as [number, number], reason: 'solved first' }
  const when = f.when ?? days(1)
  const actions = Array.from({ length: f.moves ?? 4 }, (_, i) => [i, seat, i] as [number, 0 | 1, number])
  const record = encodeRecord({ schema: 1, matchId: id, game, coreVersion: '1', agent: { version: 'v1', level }, seed: n, humanSeat: seat, actions, result, finalHash: '0123456789abcdef', startedAt: when.toISOString(), endedAt: when.toISOString(), device: 'desktop', input: 'mouse', trainingAllowed: true })
  await db.insert(schema.match).values({ id, game, guestId: f.userId ? null : f.who, userId: f.userId ?? null, agentVersion: 'v1', level, seed: n, status: 'finished', result, record, recordValid: true, trainingAllowed: true, startedAt: when, finishedAt: when })
}

describe('level board', () => {
  test('ranks wins per level for guests by name, breaks ties by fewest moves, counts players, repeats get a number', async () => {
    const a = GID('a'), b = GID('b'), c = GID('c'), d = GID('d')
    await guest(a, 'Mika'); await guest(b, 'mika'); await guest(c, 'Priya'); await guest(d)
    for (const who of [a, a]) await put({ who, level: 'easy', moves: 5 })
    for (const who of [b, b]) await put({ who, level: 'easy', moves: 3 })
    await put({ who: c, level: 'easy' })
    await put({ who: c, level: 'easy', win: false })
    await put({ who: d, level: 'medium' })
    await put({ who: a, level: 'medium', win: false })
    const board = await getLevelBoard(db, 'word', {}, new Set(), NOW)
    const easy = board.columns[0]!
    expect(easy.players).toBe(3)
    expect(easy.rows.map((r) => [r.rank, r.name, r.wins])).toEqual([[1, 'mika', 2], [2, 'Mika 2', 2], [3, 'Priya', 1]])
    const medium = board.columns[1]!
    expect(medium.players).toBe(2)
    expect(medium.rows.map((r) => r.name)).toEqual([`guest ${'d'.repeat(4)}`])
    expect(board.columns[2]!.rows).toEqual([])
  })
  test('thirty day window, valid records only, and a Practice level is never ranked', async () => {
    const a = GID('a')
    await guest(a, 'Mika')
    await put({ who: a, level: 'easy', when: days(40) })
    await put({ who: a, level: 'hard' })
    await put({ who: a, level: 'easy' })
    await db.execute(sql`update match set record_valid = false where id = (select id from match where level = 'easy' order by finished_at desc limit 1)`)
    const board = await getLevelBoard(db, 'word', { guestId: a }, new Set<Level>(['hard']), NOW)
    expect(board.columns[0]!.rows).toEqual([])
    expect(board.columns[2]!.practice).toBe(true)
    expect(board.columns[2]!.rows).toEqual([])
    expect(board.columns[2]!.players).toBe(1)
  })
  test('top ten, a "more" count, the viewer pinned with their rank, and a hidden player left out', async () => {
    for (let i = 0; i < 12; i++) {
      const id = GID(i.toString(16))
      await guest(id, `P${i}`, i !== 11)
      for (let k = 0; k < 20 - i; k++) await put({ who: id })
    }
    const me = GID('a')
    // player 11 (b) is hidden: ranks only count the other eleven, and the viewer is the last of them
    const board = await getLevelBoard(db, 'word', { guestId: me }, new Set(), NOW)
    const easy = board.columns[0]!
    expect(easy.rows).toHaveLength(10)
    expect(easy.more).toBe(1)
    expect(easy.players).toBe(12)
    const own = easy.rows.find((r) => r.me)
    expect(own).toBeUndefined()
    expect(easy.me).toEqual({ rank: 11, wins: 10, name: 'P10', hidden: false })
  })
  test('the viewer who hid themselves sees that, not a rank', async () => {
    const a = GID('a')
    await guest(a, 'Mika', false)
    await put({ who: a })
    const board = await getLevelBoard(db, 'word', { guestId: a }, new Set(), NOW)
    expect(board.columns[0]!.rows).toEqual([])
    expect(board.columns[0]!.me).toEqual({ rank: null, wins: 1, name: 'You', hidden: true })
  })
})

describe('opponent records', () => {
  test('wins and losses against people per level over all games, draws left out', async () => {
    const a = GID('a')
    await put({ who: a, level: 'easy' })
    await put({ who: a, level: 'easy', game: 'chess', win: false })
    await put({ who: a, level: 'easy', win: false })
    await put({ who: a, level: 'champion', when: days(45) })
    const rec = await getOpponentRecords(db, NOW)
    expect(rec.find((r) => r.level === 'easy')).toEqual({ level: 'easy', wins: 2, losses: 1 })
    expect(rec.find((r) => r.level === 'champion')).toEqual({ level: 'champion', wins: 0, losses: 0 })
  })
})

describe('opponent records cache', () => {
  test('a second read inside the TTL is served from memory, a read after it sees new matches', async () => {
    const a = GID('c')
    const t0 = NOW.getTime()
    const first = await getOpponentRecordsCached(db, t0, 60_000)
    await put({ who: a, level: 'medium', when: days(1) })
    const again = await getOpponentRecordsCached(db, t0 + 30_000, 60_000)
    expect(again).toBe(first)
    const later = await getOpponentRecordsCached(db, t0 + 61_000, 60_000)
    expect(later.find((r) => r.level === 'medium')!.losses).toBeGreaterThan(first.find((r) => r.level === 'medium')!.losses)
  })
})

describe('path', () => {
  test('a stop is cleared by one finished win at that level, Practice included, for this player only', async () => {
    const a = GID('a'), b = GID('b')
    await put({ who: a, level: 'easy' })
    await put({ who: a, level: 'medium', win: false })
    await put({ who: a, level: 'hard', seat: 1 })
    await put({ who: b, level: 'medium' })
    expect(await getPath(db, { guestId: a }, 'word')).toEqual({ easy: true, medium: false, hard: true, champion: false })
    expect(await getPath(db, { guestId: a }, 'chess')).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(await getPath(db, {}, 'word')).toEqual({ easy: false, medium: false, hard: false, champion: false })
  })
})

describe('identity and the call', () => {
  test('a guest saves a checked name; a signed-in player gets the guest name copied once', async () => {
    const g = (await resolveGuest(db, null)).id
    expect(await saveName(db, { guestId: g }, 'a@b.co')).toEqual({ ok: false, error: 'Just a name, no links or emails.' })
    expect(await saveName(db, { guestId: g }, '  Mika  ')).toEqual({ ok: true, name: 'Mika' })
    expect((await getIdentity(db, { guestId: g })).name).toBe('Mika')
    expect(await getIdentity(db, { userId: 'u-9', guestId: g })).toEqual({ name: 'Mika', signedIn: true, showOnBoard: true })
    await saveName(db, { guestId: g }, 'Mika Two')
    expect((await getIdentity(db, { userId: 'u-9', guestId: g })).name).toBe('Mika')
    await setGuestBoardVisibility(db, g, false)
    expect((await getIdentity(db, { guestId: g })).showOnBoard).toBe(false)
  })
  test('start stores a valid call and ignores anything else', async () => {
    const g = (await resolveGuest(db, null)).id
    const ok = await startMatchHandler(db, { game: 'word', level: 'easy', call: 'hard' }, { guestId: g })
    const junk = await startMatchHandler(db, { game: 'word', level: 'easy', call: 'ultra' }, { guestId: g })
    const rows = await db.select({ id: schema.match.id, call: schema.match.call }).from(schema.match)
    const byId = new Map(rows.map((r) => [r.id, r.call]))
    expect(byId.get((ok.body as { matchId: string }).matchId)).toBe('hard')
    expect(byId.get((junk.body as { matchId: string }).matchId)).toBeNull()
  })
})
