import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { adminOverviewHandler, adminPeopleHandler, adminPlayerHandler, parsePeopleParams, type PlayerDetail } from './admin-owner'
import { playerRef } from './telemetry'
import { revealEmailsHandler } from './telemetry-owner'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())

const NOW = new Date('2026-10-30T12:00:00.000Z')
const days = (d: number, h = 0) => new Date(NOW.getTime() - d * 86_400_000 - h * 3_600_000)
const ENV = { OWNER_EMAILS: 'owner@example.com' }
const OWNER = { id: 'u-owner', email: 'owner@example.com', emailVerified: true }
const OTHER = { id: 'u-other', email: 'other@example.com', emailVerified: true }
const GUEST_VIEWER = null
const G1 = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa'
const G2 = 'bbbbbbbb-1111-2222-3333-bbbbbbbb0042'
const G3 = 'cccccccc-1111-2222-3333-cccccccccccc'
const practiceFor = (game: GameId): ReadonlySet<Level> => (game === 'arena' ? new Set<Level>(['champion']) : new Set<Level>())

let n = 0
interface Put {
  guestId?: string
  userId?: string
  game?: GameId
  level?: Level
  win?: boolean | null
  status?: schema.MatchStatus
  valid?: boolean
  reason?: string
  when?: Date
}
async function put(f: Put) {
  const id = `m-${++n}`
  const game = f.game ?? 'word'
  const level = f.level ?? 'easy'
  const status = f.status ?? 'finished'
  const when = f.when ?? days(1)
  const seat = 0
  const winner = f.win === null ? null : f.win === false ? 1 : 0
  const result = { winner: winner as 0 | 1 | null, score: [1, 0] as [number, number], reason: 'done' }
  const record =
    status === 'finished'
      ? encodeRecord({ schema: 1, matchId: id, game, coreVersion: '1', agent: { version: 'v1', level }, seed: n, humanSeat: seat, actions: [[0, seat, 1]], result, finalHash: '0123456789abcdef', startedAt: when.toISOString(), endedAt: when.toISOString(), device: 'desktop', input: 'mouse', trainingAllowed: true })
      : null
  await db.insert(schema.match).values({
    id, game, userId: f.userId ?? null, guestId: f.userId ? null : (f.guestId ?? null), agentVersion: 'v1', level, seed: n, status,
    result: status === 'finished' ? result : null, record, recordValid: status === 'finished' ? (f.valid ?? true) : null, invalidReason: f.reason ?? null,
    trainingAllowed: true, startedAt: when, finishedAt: status === 'finished' ? when : null,
  })
  return id
}

beforeEach(async () => {
  n = 0
  await db.execute(sql`truncate table match, guest, profile, owner_audit, account, "user" cascade`)
  await db.insert(schema.guest).values([
    { id: G1, displayName: 'Wren', createdAt: days(10) },
    { id: G2, createdAt: days(2) },
    { id: G3, displayName: 'Hidden Hal', showOnLeaderboard: false, createdAt: days(40) },
  ])
  await db.insert(schema.user).values([
    { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com', createdAt: days(5) },
    { id: OWNER.id, name: 'Owner', email: OWNER.email, createdAt: days(60) },
  ])
  await db.insert(schema.profile).values({ userId: 'u-ada', displayName: 'Countess' })
  // Wren: 3 finished (2 wins easy/hard in word, 1 loss in chess), one resigned.
  await put({ guestId: G1, level: 'easy', win: true, when: days(3) })
  await put({ guestId: G1, level: 'hard', win: true, when: days(2) })
  await put({ guestId: G1, game: 'chess', level: 'medium', win: false, when: days(1) })
  await put({ guestId: G1, game: 'four', level: 'easy', status: 'resigned', when: days(0, 5) })
  // guest 0042: one draw.
  await put({ guestId: G2, win: null, when: days(0, 2) })
  // Ada (signed in): arena champion (practice) win, plus an invalid word win.
  await put({ userId: 'u-ada', game: 'arena', level: 'champion', win: true, when: days(0, 1) })
  await put({ userId: 'u-ada', level: 'medium', win: true, valid: false, reason: 'replay mismatch', when: days(4) })
})

describe('access', () => {
  test('a guest, a signed-in non-owner and a missing allowlist get 404 from every function and no data', async () => {
    const ref = await playerRef('guest', G1)
    for (const [user, env] of [[GUEST_VIEWER, ENV], [OTHER, ENV], [OWNER, {}], [{ ...OWNER, emailVerified: false }, ENV]] as const) {
      const expected = { status: 404, body: { error: 'not found' } }
      expect(await adminOverviewHandler(db, user, env, NOW)).toEqual(expected)
      expect(await adminPeopleHandler(db, user, env, {})).toEqual(expected)
      expect(await adminPlayerHandler(db, user, env, { ref }, practiceFor)).toEqual(expected)
    }
  })

  test('an owner asking for a missing or malformed ref gets 404 or 400, never someone else', async () => {
    expect((await adminPlayerHandler(db, OWNER, ENV, { ref: 'pl_00000000' }, practiceFor)).status).toBe(404)
    expect((await adminPlayerHandler(db, OWNER, ENV, { ref: "x'; drop table match;--" }, practiceFor)).status).toBe(400)
    expect((await adminPlayerHandler(db, OWNER, ENV, null, practiceFor)).status).toBe(400)
  })
})

describe('overview', () => {
  test('counts players, per-day trends over 14 days and matches per game', async () => {
    const r = await adminOverviewHandler(db, OWNER, ENV, NOW)
    expect(r.status).toBe(200)
    const b = r.body as Awaited<ReturnType<typeof adminOverviewHandler>>['body'] & { players: { total: number; guests: number; accounts: number } }
    expect(b.players).toEqual({ total: 5, guests: 3, accounts: 2 })
    const o = b as unknown as import('./admin-owner').AdminOverview
    expect(o.newPerDay).toHaveLength(14)
    expect(o.newPerDay.at(-1)!.day).toBe('2026-10-30')
    expect(o.newPerDay.find((d) => d.day === '2026-10-28')!.count).toBe(1) // guest 0042
    expect(o.newPerDay.find((d) => d.day === '2026-10-25')!.count).toBe(1) // Ada
    expect(o.newPerDay.reduce((s, d) => s + d.count, 0)).toBe(3) // the others joined before the window
    expect(o.matchesPerDay).toHaveLength(14)
    expect(o.matchesPerDay.reduce((s, d) => s + d.count, 0)).toBe(6) // the resigned match is not a finished one
    expect(o.matchesPerGame.find((g) => g.game === 'word')!.count).toBe(4)
    expect(o.matchesPerGame.find((g) => g.game === 'chess')!.count).toBe(1)
    expect(o.matchesPerGame.find((g) => g.game === 'four')!.count).toBe(0)
  })

  test('the feed is the last 50 finished matches, newest first, with a label and a result, and no email', async () => {
    for (let i = 0; i < 60; i++) await put({ guestId: G2, win: i % 2 === 0, when: new Date(NOW.getTime() - i * 60_000) })
    const o = (await adminOverviewHandler(db, OWNER, ENV, NOW)).body as import('./admin-owner').AdminOverview
    expect(o.feed).toHaveLength(50)
    const times = o.feed.map((f) => f.at)
    expect([...times].sort().reverse()).toEqual(times)
    expect(o.feed[0]).toMatchObject({ name: 'guest 0042', kind: 'guest', game: 'word', level: 'easy', result: 'won' })
    expect(o.feed[0]!.ref).toMatch(/^pl_[0-9a-f]{8}$/)
    expect(JSON.stringify(o)).not.toContain('@')
  })

  test('hidden players still appear to the owner, marked hidden', async () => {
    await put({ guestId: G3, when: days(0, 1) })
    const o = (await adminOverviewHandler(db, OWNER, ENV, NOW)).body as import('./admin-owner').AdminOverview
    expect(o.feed.find((f) => f.name === 'Hidden Hal')).toMatchObject({ hidden: true })
  })
})

describe('people table', () => {
  const people = async (q: Record<string, unknown> = {}) => {
    const r = await adminPeopleHandler(db, OWNER, ENV, q)
    expect(r.status).toBe(200)
    return r.body as import('./admin-owner').PeoplePage
  }

  test('lists guests and accounts with names, kind, joined, matches per game and wins per level', async () => {
    const page = await people()
    expect(page.total).toBe(5)
    const wren = page.rows.find((r) => r.name === 'Wren')!
    expect(wren).toMatchObject({ kind: 'guest', matches: 3, hidden: false, perGame: { word: 2, chess: 1 }, winsByLevel: { easy: 1, medium: 0, hard: 1, champion: 0 } })
    expect(wren.joinedAt).toBe(days(10).toISOString())
    expect(wren.lastSeenAt).toBe(days(0, 5).toISOString()) // the resigned match is the latest sign of life
    const nameless = page.rows.find((r) => r.name === 'guest 0042')!
    expect(nameless).toMatchObject({ kind: 'guest', matches: 1, winsByLevel: { easy: 0, medium: 0, hard: 0, champion: 0 } })
    const ada = page.rows.find((r) => r.name === 'Countess')!
    expect(ada).toMatchObject({ kind: 'user', matches: 2, perGame: { arena: 1, word: 1 } })
    expect(ada.winsByLevel).toMatchObject({ champion: 1, medium: 1 })
    expect(page.rows.find((r) => r.name === 'Hidden Hal')).toMatchObject({ hidden: true, matches: 0 })
    expect(page.rows.find((r) => r.name === 'Owner')).toMatchObject({ kind: 'user' })
    expect(JSON.stringify(page)).not.toContain('@')
    expect(JSON.stringify(page)).not.toContain(G1)
  })

  test('sorts by last seen, joined and matches in both directions', async () => {
    expect((await people({ sort: 'last' })).rows.map((r) => r.name)[0]).toBe('Countess')
    expect((await people({ sort: 'joined', dir: 'asc' })).rows.map((r) => r.name)).toEqual(['Owner', 'Hidden Hal', 'Wren', 'Countess', 'guest 0042'])
    expect((await people({ sort: 'joined' })).rows[0]!.name).toBe('guest 0042')
    const byMatches = (await people({ sort: 'matches' })).rows.map((r) => r.matches)
    expect(byMatches).toEqual([...byMatches].sort((a, b) => b - a))
    expect((await people({ sort: 'matches', dir: 'asc' })).rows[0]!.matches).toBe(0)
  })

  test('searches the name, ignores case, treats % and _ literally', async () => {
    expect((await people({ q: 'wRe' })).rows.map((r) => r.name)).toEqual(['Wren'])
    expect((await people({ q: 'guest' })).rows.map((r) => r.name)).toEqual(['guest 0042'])
    expect((await people({ q: '%' })).total).toBe(0)
    expect((await people({ q: '_' })).total).toBe(0)
    expect((await people({ q: "'; drop table match; --" })).total).toBe(0)
    expect((await people({ q: 'zzz' })).rows).toEqual([])
  })

  test('paginates 20 at a time with the total of the whole filtered list', async () => {
    await db.insert(schema.guest).values(Array.from({ length: 30 }, (_, i) => ({ id: `dddddddd-0000-0000-0000-${String(i).padStart(12, '0')}`, displayName: `Bot ${String(i).padStart(2, '0')}`, createdAt: days(20, i) })))
    const first = await people({ sort: 'joined', dir: 'asc' })
    const second = await people({ sort: 'joined', dir: 'asc', page: 1 })
    const third = await people({ sort: 'joined', dir: 'asc', page: 2 })
    expect([first.total, first.rows.length, second.rows.length, third.rows.length]).toEqual([35, 20, 15, 0])
    expect(new Set([...first.rows, ...second.rows].map((r) => r.ref)).size).toBe(35)
    expect((await people({ q: 'bot', page: 1 })).rows).toHaveLength(10)
  })

  test('unknown sort and page values fall back to safe defaults', () => {
    expect(parsePeopleParams({ sort: 'name; drop', dir: 'sideways', page: '-3', q: 'a'.repeat(100) })).toEqual({ sort: 'last', dir: 'desc', page: 0, q: 'a'.repeat(40) })
  })
})

describe('player drill-down', () => {
  test('returns the full history with result, counted or practice, valid or invalid with a reason, and the path', async () => {
    const ref = await playerRef('user', 'u-ada')
    const r = await adminPlayerHandler(db, OWNER, ENV, { ref }, practiceFor)
    expect(r.status).toBe(200)
    const d = r.body as PlayerDetail
    expect(d).toMatchObject({ ref, kind: 'user', name: 'Countess', hidden: false, matchesTotal: 2 })
    expect(d.matches.map((m) => m.game)).toEqual(['arena', 'word']) // newest first
    expect(d.matches[0]).toMatchObject({ result: 'won', practice: true, counted: false, valid: true, invalidReason: null })
    expect(d.matches[1]).toMatchObject({ result: 'won', practice: false, counted: false, valid: false, invalidReason: 'replay mismatch' })
    // The arena win on a Practice level clears the stop on the path; the invalid word win does not.
    expect(d.path.find((p) => p.game === 'arena')!.cleared).toEqual({ easy: false, medium: false, hard: false, champion: true })
    expect(d.path.find((p) => p.game === 'word')!.cleared).toEqual({ easy: false, medium: false, hard: false, champion: false })
    expect(d.path).toHaveLength(6)
    expect(JSON.stringify(d)).not.toContain('@')
  })

  test('a guest history shows resigned matches, counted wins and the path', async () => {
    const d = (await adminPlayerHandler(db, OWNER, ENV, { ref: await playerRef('guest', G1) }, practiceFor)).body as PlayerDetail
    expect(d).toMatchObject({ kind: 'guest', name: 'Wren', matchesTotal: 4 })
    expect(d.matches[0]).toMatchObject({ game: 'four', result: 'resigned', counted: false, valid: false })
    expect(d.matches.filter((m) => m.counted)).toHaveLength(3)
    expect(d.matches.find((m) => m.game === 'chess')).toMatchObject({ result: 'lost', counted: true })
    expect(d.path.find((p) => p.game === 'word')!.cleared).toEqual({ easy: true, medium: false, hard: true, champion: false })
  })

  test('a player with no matches still opens', async () => {
    const d = (await adminPlayerHandler(db, OWNER, ENV, { ref: await playerRef('guest', G3) }, practiceFor)).body as PlayerDetail
    expect(d).toMatchObject({ name: 'Hidden Hal', hidden: true, matches: [], matchesTotal: 0 })
  })

  test('another player never leaks into a history', async () => {
    const d = (await adminPlayerHandler(db, OWNER, ENV, { ref: await playerRef('guest', G2) }, practiceFor)).body as PlayerDetail
    expect(d.matches).toHaveLength(1)
    expect(d.matches[0]!.result).toBe('draw')
  })
})

describe('privacy', () => {
  test('the email reveal stays audited and is still the only place an email comes from', async () => {
    const ref = await playerRef('user', 'u-ada')
    const r = await revealEmailsHandler(db, OWNER, ENV, { refs: [ref] }, NOW)
    expect(r.body).toEqual({ emails: { [ref]: 'ada@example.com' } })
    expect(await db.select().from(schema.ownerAudit)).toHaveLength(1)
    const people = JSON.stringify((await adminPeopleHandler(db, OWNER, ENV, {})).body)
    expect(people).not.toContain('ada@example.com')
  })
})
