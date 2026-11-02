import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { adminActiveHandler, adminOverviewHandler, adminPeopleHandler, adminPlayerHandler, parsePeopleParams, type PlayerDetail } from './admin-owner'
import { playerRef } from './telemetry'
import { claimGuestForOwner } from './guest'
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
    trainingAllowed: true, startedAt: when, finishedAt: status === 'finished' || status === 'resigned' || status === 'abandoned' ? when : null, // the server stamps finished_at on a resign and an abandon too
  })
  return id
}

beforeEach(async () => {
  n = 0
  await db.execute(sql`truncate table match, guest, profile, telemetry_event, owner_audit, account, "user" cascade`)
  await db.insert(schema.guest).values([
    { id: G1, displayName: 'Wren', createdAt: days(10) },
    { id: G2, createdAt: days(2) },
    { id: G3, displayName: 'Hidden Hal', showOnLeaderboard: false, createdAt: days(40) },
  ])
  await db.insert(schema.user).values([
    { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com', createdAt: days(5) },
    { id: OWNER.id, name: 'Owner', email: OWNER.email, emailVerified: true, createdAt: days(60) },
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
    const o = r.body as import('./admin-owner').AdminOverview
    expect(o.players.all).toEqual({ human: 4, owner: 1, test: 0, total: 5 }) // the owner's account is the owner
    expect(o.players.guests).toEqual({ human: 3, owner: 0, test: 0, total: 3 })
    expect(o.players.accounts).toEqual({ human: 1, owner: 1, test: 0, total: 2 })
    expect(o.newPerDay).toHaveLength(14)
    expect(o.newPerDay.at(-1)!.day).toBe('2026-10-30')
    expect(o.newPerDay.find((d) => d.day === '2026-10-28')!.total).toBe(1) // guest 0042
    expect(o.newPerDay.find((d) => d.day === '2026-10-25')!.total).toBe(1) // Ada
    expect(o.newPerDay.reduce((s, d) => s + d.total, 0)).toBe(3) // the others joined before the window
    expect(o.matchesPerDay).toHaveLength(14)
    expect(o.matchesPerDay.reduce((s, d) => s + d.total, 0)).toBe(7) // played = finished, resigned or abandoned: the resigned four match counts
    expect(o.matchesPerGame.find((g) => g.game === 'word')!.total).toBe(4)
    expect(o.matchesPerGame.find((g) => g.game === 'chess')!.total).toBe(1)
    expect(o.matchesPerGame.find((g) => g.game === 'four')!.total).toBe(1) // Wren's resigned match
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
    expect(page.totalBy).toEqual({ human: 4, owner: 1, test: 0, total: 5 })
    expect(page.rows.map((r) => [r.name, r.traffic]).sort()).toEqual([['Countess', 'human'], ['Hidden Hal', 'human'], ['Owner', 'owner'], ['Wren', 'human'], ['guest 0042', 'human']])
    const wren = page.rows.find((r) => r.name === 'Wren')!
    expect(wren).toMatchObject({ kind: 'guest', matches: 4, hidden: false, perGame: { word: 2, chess: 1, four: 1 }, winsByLevel: { easy: 1, medium: 0, hard: 1, champion: 0 } })
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

  test('a match played in Practice mode is played and tagged, but not counted and never a path clear', async () => {
    const id = await put({ guestId: G3, game: 'chess', level: 'hard', win: true, when: days(1) })
    await db.update(schema.match).set({ filterFlags: { practice: true } }).where(eq(schema.match.id, id))
    const d = (await adminPlayerHandler(db, OWNER, ENV, { ref: await playerRef('guest', G3) }, practiceFor)).body as PlayerDetail
    expect(d.playedTotal).toBe(1)
    expect(d.matches[0]).toMatchObject({ result: 'won', practiceMode: true, practice: false, counted: false, valid: true })
    expect(d.path.find((p) => p.game === 'chess')!.cleared.hard).toBe(false)
    const feed = (await adminOverviewHandler(db, OWNER, ENV, NOW)).body as import('./admin-owner').AdminOverview
    expect(feed.feed.find((f) => f.matchId === id)?.practiceMode).toBe(true)
    expect(feed.feed.filter((f) => f.matchId !== id).every((f) => f.practiceMode === false)).toBe(true)
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


// The zone is explicit in every call: 'UTC' keeps the original UTC-day expectations meaningful.
const OV = async (zone: unknown = 'UTC', now: Date = NOW): Promise<import('./admin-owner').AdminOverview> => (await adminOverviewHandler(db, OWNER, ENV, now, zone)).body as import('./admin-owner').AdminOverview
const AC = async (zone: unknown = 'UTC', now: Date = NOW): Promise<import('./admin-owner').ActiveUsers> => (await adminActiveHandler(db, OWNER, ENV, now, zone)).body as import('./admin-owner').ActiveUsers
const PG = async (q: Record<string, unknown> = {}): Promise<import('./admin-owner').PeoplePage> => (await adminPeopleHandler(db, OWNER, ENV, q)).body as import('./admin-owner').PeoplePage
const parts = (s: import('./admin-owner').Split) => s.human + s.owner + s.test
const addsUp = (s: import('./admin-owner').Split) => expect(parts(s)).toBe(s.total)

/** Marks a guest as test traffic the way the server does at write time: the guest row and its matches carry traffic = 'test'. */
async function tagGuest(id: string, traffic: 'test' | 'owner') {
  await db.update(schema.guest).set({ traffic }).where(sql`id = ${id}`)
  await db.update(schema.match).set({ traffic }).where(sql`guest_id = ${id}`)
}
/** The pre-column signal: a telemetry event whose device is "headless". */
async function legacyHeadless(kind: 'user' | 'guest', id: string) {
  await db.insert(schema.telemetryEvent).values({
    id: crypto.randomUUID(), at: NOW, kind: 'match_started', matchId: `t-${id}`, game: 'word', level: 'easy', persona: 'Pip', device: 'headless',
    trainingBasis: 'legitimate-interest', playerRef: await playerRef(kind, id), playerKind: kind,
  })
}

describe('active players', () => {
  test('DAU, WAU, MAU and returning count distinct players across guests and accounts, by day in the asked zone (UTC here)', async () => {
    // Seed: Wren played on days 3,2,1 and resigned one today; guest 0042 one today; Ada arena today and word 4 days ago. All human.
    const a = await AC()
    expect([a.dau.human, a.wau.human, a.mau.human, a.returning7.human, a.returning30.human]).toEqual([3, 3, 3, 2, 2])
    expect(a.perDay).toHaveLength(30)
    expect(a.perDay.at(-1)).toMatchObject({ day: '2026-10-30', human: 3, total: 3 })
    expect(a.perDay.find((d) => d.day === '2026-10-29')!.total).toBe(1)
    expect(a.perDay.reduce((s, d) => s + d.total, 0)).toBe(7)
  })

  test('in zone UTC the windows are UTC days: 8 days ago is in MAU only, 00:00 today is in DAU', async () => {
    await put({ guestId: G3, win: true, when: days(8) })
    await put({ guestId: G3, win: true, when: new Date('2026-10-30T00:00:00.000Z') })
    await put({ guestId: G3, win: true, when: new Date('2026-10-29T23:59:59.000Z') })
    const a = await AC()
    expect(a.dau.total).toBe(4)
    expect(a.mau.total).toBe(4)
    expect(a.returning30.total).toBe(3)
  })

  test('matches still in progress, offline tickets and empty history count nobody', async () => {
    await db.execute(sql`truncate table match cascade`)
    await put({ guestId: G1, status: 'started' })
    await put({ guestId: G1, status: 'ticket' })
    const a = await AC()
    for (const s of [a.dau, a.wau, a.mau, a.returning7, a.returning30]) expect(s).toEqual({ human: 0, owner: 0, test: 0, total: 0 })
    expect(a.perDay.every((d) => d.total === 0)).toBe(true)
  })

  test('404 for a guest, a non-owner and no allowlist', async () => {
    for (const who of [GUEST_VIEWER, OTHER]) expect((await adminActiveHandler(db, who, ENV, NOW)).status).toBe(404)
    expect((await adminActiveHandler(db, OWNER, {}, NOW)).status).toBe(404)
  })
})

describe('traffic classes', () => {
  test('a test-tagged guest and an owner account never reach the human numbers, and are broken out beside them', async () => {
    await tagGuest(G1, 'test') // Wren: 3 finished matches, played from a test script
    await put({ userId: OWNER.id, win: true, when: days(0, 3) }) // the owner plays too
    const o = await OV()
    expect(o.players.all).toEqual({ human: 3, owner: 1, test: 1, total: 5 })
    expect(o.matchesPerGame.find((g) => g.game === 'word')!).toMatchObject({ human: 2, owner: 1, test: 2, total: 5 })
    expect(o.matchesPerGame.find((g) => g.game === 'chess')!).toMatchObject({ human: 0, test: 1 })
    expect(o.feed.find((f) => f.name === 'Wren')!.traffic).toBe('test')
    expect(o.feed.find((f) => f.name === 'Owner')!.traffic).toBe('owner')
    expect(o.feed.find((f) => f.name === 'Countess')!.traffic).toBe('human')
    const a = await AC()
    expect([a.dau, a.wau, a.mau].map((s) => s.human)).toEqual([2, 2, 2]) // guest 0042 and Ada only
    expect(a.mau).toEqual({ human: 2, owner: 1, test: 1, total: 4 })
    expect(a.returning30).toEqual({ human: 1, owner: 0, test: 1, total: 2 }) // Ada on 2 days, Wren on 3 (test)
    const pg = await PG()
    expect(pg.totalBy).toEqual({ human: 3, owner: 1, test: 1, total: 5 })
    expect(pg.rows.find((r) => r.name === 'Wren')!.traffic).toBe('test')
  })

  test('a guest first seen on the owner device is the owner, and so are its matches', async () => {
    await tagGuest(G2, 'owner')
    const o = await OV()
    expect(o.players.guests).toEqual({ human: 2, owner: 1, test: 0, total: 3 })
    expect(o.feed.find((f) => f.name === 'guest 0042')!.traffic).toBe('owner')
    expect((await AC()).dau).toEqual({ human: 2, owner: 1, test: 0, total: 3 }) // Wren (resigned today) and Ada; guest 0042 is the owner
  })

  test('rows from before the column fall back to the headless telemetry signal', async () => {
    await legacyHeadless('guest', G1)
    const o = await OV()
    expect(o.players.all).toEqual({ human: 3, owner: 1, test: 1, total: 5 })
    expect((await PG({ q: 'wren' })).rows[0]!.traffic).toBe('test')
    await legacyHeadless('user', 'u-ada')
    expect((await OV()).players.accounts).toEqual({ human: 0, owner: 1, test: 1, total: 2 })
  })

  test('an account on OWNER_EMAILS is the owner even when a script drives it; the verified-email rule matches isOwner', async () => {
    const both = { OWNER_EMAILS: 'owner@example.com,ada@example.com' }
    const accounts = async () => ((await adminOverviewHandler(db, OWNER, both, NOW)).body as import('./admin-owner').AdminOverview).players.accounts
    await db.update(schema.match).set({ traffic: 'test' }).where(sql`user_id = 'u-ada'`)
    await db.update(schema.user).set({ emailVerified: true }).where(sql`id = 'u-ada'`)
    expect(await accounts()).toEqual({ human: 0, owner: 2, test: 0, total: 2 })
    await db.update(schema.user).set({ emailVerified: false }).where(sql`id = 'u-ada'`) // unverified: not the owner; its tagged matches make it test
    expect(await accounts()).toEqual({ human: 0, owner: 1, test: 1, total: 2 })
  })

  test('human + owner + test equals the total on every stat, with a mix of all three', async () => {
    await tagGuest(G1, 'test')
    await tagGuest(G2, 'owner')
    await put({ userId: OWNER.id, game: 'chess', when: days(2) })
    await put({ guestId: G3, game: 'four', win: true, when: days(0, 1) })
    const o = await OV()
    for (const s of [o.players.all, o.players.guests, o.players.accounts, ...o.newPerDay, ...o.matchesPerDay, ...o.matchesPerGame]) addsUp(s)
    expect(o.matchesPerDay.reduce((n, d) => n + d.total, 0)).toBe(9)
    expect(o.matchesPerGame.reduce((n, g) => n + g.total, 0)).toBe(9)
    expect(o.players.all.total).toBe(o.players.guests.total + o.players.accounts.total)
    const a = await AC()
    for (const s of [a.dau, a.wau, a.mau, a.returning7, a.returning30, ...a.perDay]) addsUp(s)
    const pg = await PG()
    addsUp(pg.totalBy)
    expect(pg.total).toBe(pg.totalBy.total)
    expect(pg.totalBy).toEqual(o.players.all) // the same players, however they are counted
    // Every player is in exactly one class: the people list tags each row once and the tags add up to the same split.
    const tags = pg.rows.map((r) => r.traffic)
    expect(tags.filter((t) => t === 'human').length).toBe(pg.totalBy.human)
    expect(tags.filter((t) => t === 'owner').length).toBe(pg.totalBy.owner)
    expect(tags.filter((t) => t === 'test').length).toBe(pg.totalBy.test)
  })

  test('the owner view breaks AI win rate, players and matches down by class, and the parts add up', async () => {
    const { ownerViewHandler } = await import('./telemetry-owner')
    const ev = async (kind: 'user' | 'guest', id: string, matchId: string, outcome: 'human' | 'ai', device = 'desktop') =>
      [
        { kind: 'match_started', outcome: null, durationMs: null },
        { kind: 'match_finished', outcome, durationMs: 60_000 },
      ].map((e) => ({
        id: crypto.randomUUID(), at: days(0, 3), kind: e.kind as schema.TelemetryKind, matchId, game: 'chess', level: 'easy', persona: 'Pip', device, outcome: e.outcome, durationMs: e.durationMs,
        trainingBasis: 'legitimate-interest', playerRef: '', playerKind: kind, _id: id,
      }))
    const rows = [
      ...(await ev('guest', G2, 'h1', 'ai')), // human: AI won
      ...(await ev('guest', G1, 'h2', 'human')), // test (tagged below)
      ...(await ev('guest', G1, 'h3', 'ai', 'headless')),
      ...(await ev('user', OWNER.id, 'h4', 'human')), // owner
    ]
    await tagGuest(G1, 'test')
    for (const r of rows) {
      const { _id, ...row } = r
      await db.insert(schema.telemetryEvent).values({ ...row, playerRef: await playerRef(row.playerKind as 'user' | 'guest', _id) })
    }
    const target = () => null
    const v = (await ownerViewHandler(db, OWNER, ENV, {}, target, NOW)).body as import('./telemetry-stats').OwnerViewBody
    const k = v.kpisBy
    expect(k.human.matches.value).toBe(1)
    expect(k.human.aiWin).toMatchObject({ rated: 1, rate: 1 })
    expect(k.test.matches.value).toBe(2)
    expect(k.owner.matches.value).toBe(1)
    expect(k.total.matches.value).toBe(k.human.matches.value + k.owner.matches.value + k.test.matches.value)
    expect(k.total.players.value).toBe(k.human.players.value + k.owner.players.value + k.test.players.value)
    expect(k.total.aiWin.rated).toBe(k.human.aiWin.rated + k.owner.aiWin.rated + k.test.aiWin.rated)
    expect(k.total.aiWin.rate).toBeCloseTo(2 / 4, 5) // 2 AI wins of 4 rated, mixed; the human headline stays 100 percent
    // The panels follow the lens: humans by default, then each class, then everyone.
    expect(v.who).toBe('human')
    expect(v.kpis.matches.value).toBe(1)
    const lens = async (who: string) => ((await ownerViewHandler(db, OWNER, ENV, { who }, target, NOW)).body as import('./telemetry-stats').OwnerViewBody).kpis.matches.value
    expect([await lens('owner'), await lens('test'), await lens('all')]).toEqual([1, 2, 4])
    const body = (await ownerViewHandler(db, OWNER, ENV, { who: 'nonsense' }, target, NOW)).body as import('./telemetry-stats').OwnerViewBody
    expect(body.who).toBe('human')
  })

  test('the SQL player code is the same hash playerRef() gives, so no test player is missed', async () => {
    const rows = (await db.execute(sql`select 'pl_' || left(encode(sha256(convert_to('guest:' || ${G1}, 'UTF8')), 'hex'), 8) as ref`)) as unknown as { rows?: Array<{ ref: string }> } | Array<{ ref: string }>
    const ref = Array.isArray(rows) ? rows[0]!.ref : rows.rows![0]!.ref
    expect(ref).toBe(await playerRef('guest', G1))
  })
})

describe('review round 1', () => {
  test('one test-tagged match or headless event never turns a real player into Test; only a player with no human signal is Test', async () => {
    // Wren has a human-tagged match, then one test-tagged match: still human, but that match counts as Test.
    await db.update(schema.match).set({ traffic: 'human' }).where(sql`guest_id = ${G1}`)
    const stray = await put({ guestId: G1, win: true, when: days(0, 6) })
    await db.update(schema.match).set({ traffic: 'test' }).where(sql`id = ${stray}`)
    // Guest 0042 has a headless telemetry event but a human-tagged match.
    await db.update(schema.match).set({ traffic: 'human' }).where(sql`guest_id = ${G2}`)
    await legacyHeadless('guest', G2)
    // Hal has only test signals: a test-tagged match and a test guest row.
    await tagGuest(G3, 'test')
    await put({ guestId: G3, when: days(0, 4) })
    await db.update(schema.match).set({ traffic: 'test' }).where(sql`guest_id = ${G3}`)
    const pg = await PG()
    const cls = (n: string) => pg.rows.find((r) => r.name === n)!.traffic
    expect(cls('Wren')).toBe('human')
    expect(cls('guest 0042')).toBe('human')
    expect(cls('Hidden Hal')).toBe('test')
    // Match-level counts follow each match's own tag, not the person's class.
    const o = await OV()
    expect(o.matchesPerGame.find((g) => g.game === 'word')!).toMatchObject({ test: 2 }) // Wren's stray match and Hal's
    const feedWren = o.feed.filter((f) => f.name === 'Wren')
    expect(feedWren.find((f) => f.matchId === stray)!.traffic).toBe('test')
    expect(feedWren.some((f) => f.traffic === 'human')).toBe(true)
    for (const g of o.matchesPerGame) addsUp(g)
    for (const d of o.matchesPerDay) addsUp(d)
    // Active players count each match in its own class; the parts still add up.
    const a = await AC()
    for (const x of [a.dau, a.wau, a.mau, a.returning30, ...a.perDay]) addsUp(x)
    expect(a.dau.test).toBe(2) // Wren's stray test match and Hal, both today
  })

  test('a headless telemetry event on one match of an untagged player makes that match Test, not the person', async () => {
    const m = await put({ guestId: G2, when: days(0, 3) })
    await db.insert(schema.telemetryEvent).values({
      id: crypto.randomUUID(), at: NOW, kind: 'match_started', matchId: m, game: 'word', level: 'easy', persona: 'Pip', device: 'headless',
      trainingBasis: 'legitimate-interest', playerRef: 'pl_00000000', playerKind: 'guest',
    })
    const o = await OV()
    expect(o.feed.find((f) => f.matchId === m)!.traffic).toBe('test')
    expect(o.feed.filter((f) => f.name === 'guest 0042' && f.matchId !== m).every((f) => f.traffic === 'human')).toBe(true)
  })

  test('an owner signing in on a browser whose guest has history does not relabel that guest; an empty guest becomes the owner', async () => {
    expect(await claimGuestForOwner(db, G1)).toBe(false) // Wren has matches
    expect((await db.select().from(schema.guest).where(sql`id = ${G1}`))[0]!.traffic).toBeNull()
    expect((await OV()).players.guests.human).toBe(3)
    await db.insert(schema.guest).values({ id: 'dddddddd-1111-2222-3333-dddddddddddd', traffic: 'human', createdAt: days(0, 1) })
    expect(await claimGuestForOwner(db, 'dddddddd-1111-2222-3333-dddddddddddd')).toBe(true)
    expect((await OV()).players.guests).toEqual({ human: 3, owner: 1, test: 0, total: 4 })
    // A guest already tagged test is never taken over.
    await db.insert(schema.guest).values({ id: 'eeeeeeee-1111-2222-3333-eeeeeeeeeeee', traffic: 'test' })
    expect(await claimGuestForOwner(db, 'eeeeeeee-1111-2222-3333-eeeeeeeeeeee')).toBe(false)
  })

  test('active windows follow the asked zone (UTC here) whatever the session time zone, and rows dated after now are not counted', async () => {
    await put({ guestId: G3, win: true, when: new Date('2026-10-30T02:00:00.000Z') }) // UTC day 30, but day 29 in Los Angeles
    await put({ guestId: G3, win: true, when: new Date(NOW.getTime() + 3_600_000) }) // dated in the future
    const utc = await AC()
    try {
      await client.exec("set time zone 'America/Los_Angeles'")
      const la = await AC()
      expect(la).toEqual(utc)
      await client.exec("set time zone 'Pacific/Kiritimati'")
      expect(await AC()).toEqual(utc)
    } finally {
      await client.exec("set time zone 'UTC'")
    }
    expect(utc.dau.human).toBe(4) // guest 0042, Ada, Wren (resigned today) and Hal (the 02:00 match); the future match adds nothing
    expect(utc.perDay.at(-1)!.human).toBe(4)
    expect(utc.mau.human).toBe(4) // plus Wren
  })
})

describe('only played matches count', () => {
  const snapshot = async () => ({
    o: await OV(),
    a: await AC(),
    pg: await PG(),
    detail: (await adminPlayerHandler(db, OWNER, ENV, { ref: await playerRef('guest', G1) }, practiceFor)).body as PlayerDetail,
  })

  test('offline tickets, expired tickets and a started match never played do not move any count', async () => {
    const before = await snapshot()
    // 30 tickets issued in advance, 5 expired ones and a started match that has not ended, across every kind of player.
    for (let i = 0; i < 10; i++) {
      await put({ guestId: G1, status: 'ticket', when: days(0, 2) })
      await put({ guestId: G2, status: 'ticket', when: days(0, 1) })
      await put({ userId: 'u-ada', status: 'ticket', when: days(0, 1) })
    }
    for (let i = 0; i < 5; i++) await put({ guestId: G3, status: 'expired', when: days(0, 3) })
    const after = await snapshot()
    // Every figure the page shows is unchanged except the started match below, which is not added yet.
    expect(after.o.players).toEqual(before.o.players)
    expect(after.o.matchesPerDay).toEqual(before.o.matchesPerDay)
    expect(after.o.matchesPerGame).toEqual(before.o.matchesPerGame)
    expect(after.o.feed).toEqual(before.o.feed)
    expect(after.a).toEqual(before.a)
    expect(after.pg.rows.map((r) => [r.name, r.matches, r.perGame, r.lastSeenAt])).toEqual(before.pg.rows.map((r) => [r.name, r.matches, r.perGame, r.lastSeenAt]))
    expect(after.pg.totalBy).toEqual(before.pg.totalBy)
    expect(after.detail.matchesTotal).toBe(before.detail.matchesTotal)
    expect(after.detail.matches.length).toBe(before.detail.matches.length)
    // A started match that never ended is listed as in progress for that player but is not played.
    await put({ guestId: G1, status: 'started', when: days(0, 1) })
    const started = await snapshot()
    expect(started.o.matchesPerGame).toEqual(before.o.matchesPerGame)
    expect(started.a).toEqual(before.a)
    expect(started.pg.rows.find((r) => r.name === 'Wren')!.matches).toBe(before.pg.rows.find((r) => r.name === 'Wren')!.matches)
    expect(started.detail.playedTotal).toBe(before.detail.playedTotal)
    expect(started.detail.matchesTotal).toBe(before.detail.matchesTotal + 1)
  })

  test('a resigned or abandoned match counts as played', async () => {
    const before = await AC()
    await put({ guestId: G3, status: 'abandoned', when: days(0, 1) })
    await put({ guestId: G3, game: 'chess', status: 'resigned', when: days(0, 1) })
    const o = await OV()
    expect(o.matchesPerGame.find((g) => g.game === 'chess')!.total).toBe(2)
    expect((await AC()).dau.total).toBe(before.dau.total + 1)
    expect((await PG({ q: 'hal' })).rows[0]!.matches).toBe(2)
  })

  test('a guest holding only tickets can still be claimed by an owner signing in', async () => {
    await db.insert(schema.guest).values({ id: 'ffffffff-1111-2222-3333-ffffffffffff', traffic: 'human' })
    await put({ guestId: 'ffffffff-1111-2222-3333-ffffffffffff', status: 'ticket' })
    expect(await claimGuestForOwner(db, 'ffffffff-1111-2222-3333-ffffffffffff')).toBe(true)
  })
})

describe('owner view counts played matches only', () => {
  test('a start event with no end does not move matches, players, per-game, devices or who played', async () => {
    const { ownerViewHandler } = await import('./telemetry-owner')
    const target = () => null
    const ev = async (kind: schema.TelemetryKind, matchId: string, id: string, outcome: string | null) => ({
      id: crypto.randomUUID(), at: days(0, 3), kind, matchId, game: 'chess', level: 'easy', persona: 'Pip', device: 'desktop', outcome, durationMs: outcome ? 60_000 : null,
      trainingBasis: 'legitimate-interest', playerRef: await playerRef('guest', id), playerKind: 'guest',
    })
    await db.insert(schema.telemetryEvent).values([await ev('match_started', 'p1', G2, null), await ev('match_finished', 'p1', G2, 'ai')])
    const get = async () => (await ownerViewHandler(db, OWNER, ENV, { who: 'all' }, target, NOW)).body as import('./telemetry-stats').OwnerViewBody
    const before = await get()
    await db.insert(schema.telemetryEvent).values([await ev('match_started', 'p2', G1, null), await ev('match_started', 'p3', G2, null)])
    const after = await get()
    expect(after.kpis.matches.value).toBe(before.kpis.matches.value)
    expect(after.kpis.players.value).toBe(before.kpis.players.value)
    expect(after.perGameLevel).toEqual(before.perGameLevel)
    expect(after.devices).toEqual(before.devices)
    expect(after.whoPlayed).toEqual(before.whoPlayed)
    expect(before.kpis.matches.value).toBe(1)
  })
})

// 2026-11-01 is the US fall-back day: 01:00 to 02:00 happens twice, so the local day is 25 hours long (04:00Z to 05:00Z next day in New York).
describe('owner time zone', () => {
  const FALLBACK_NOW = new Date('2026-11-02T04:30:00.000Z') // 23:30 Nov 1 in New York, 20:30 Nov 1 in Los Angeles, already Nov 2 in UTC
  const at = (iso: string) => new Date(iso)
  let g = 0
  /** One match by a brand new guest, so every match is its own player. */
  async function oneOff(when: Date) {
    const id = `dddddddd-0000-0000-0000-${String(++g).padStart(12, '0')}`
    await db.insert(schema.guest).values({ id, createdAt: days(40) })
    await put({ guestId: id, win: true, when })
  }
  async function seedFallBack() {
    await db.execute(sql`truncate table match, guest cascade`)
    g = 0
    for (const iso of [
      '2026-10-03T03:59:00.000Z', // Oct 2 23:59 in New York: one minute before the 30 day window opens
      '2026-10-03T04:00:00.000Z', // Oct 3 00:00 in New York: the first minute of the window
      '2026-11-01T03:00:00.000Z', // Oct 31 23:00 EDT
      '2026-11-01T04:30:00.000Z', // Nov 1 00:30 EDT
      '2026-11-01T05:30:00.000Z', // Nov 1 01:30 EDT (first)
      '2026-11-01T06:30:00.000Z', // Nov 1 01:30 EST (second)
      '2026-11-01T07:00:00.000Z', // Nov 1 00:00 PDT in Los Angeles
      '2026-11-02T03:00:00.000Z', // Nov 1 22:00 EST, but Nov 2 in UTC
      '2026-11-02T04:59:00.000Z', // after now: never counted
      '2026-11-02T05:00:00.000Z', // after now: Nov 2 00:00 EST
    ]) await oneOff(at(iso))
  }

  test('New York on the 25 hour fall-back day: today is Nov 1 although UTC is already Nov 2', async () => {
    await seedFallBack()
    const ny = await AC('America/New_York', FALLBACK_NOW)
    expect(ny.zone).toBe('America/New_York')
    expect(ny.zoneFallback).toBe(false)
    expect(ny.perDay).toHaveLength(30)
    expect(ny.perDay.at(-1)).toMatchObject({ day: '2026-11-01', human: 5, total: 5 }) // 00:30 EDT, both 01:30s, 02:00 EST and 22:00 EST
    expect(ny.perDay.at(-2)).toMatchObject({ day: '2026-10-31', total: 1 })
    expect(ny.perDay[0]!.day).toBe('2026-10-03')
    expect(new Set(ny.perDay.map((d) => d.day)).size).toBe(30) // the 25 hour day neither repeats nor skips a day
    expect(ny.perDay[0]!.total).toBe(1) // 04:00Z is inside, 03:59Z is not
    expect(ny.dau.human).toBe(5)
    expect(ny.wau.human).toBe(6)
    expect(ny.mau.human).toBe(7) // everything except the minute before the window and the two after now
    addsUp(ny.dau)
    addsUp(ny.mau)
    const utc = await AC('UTC', FALLBACK_NOW)
    expect(utc.perDay.at(-1)).toMatchObject({ day: '2026-11-02', total: 1 }) // only the 03:00Z match; 04:59Z is after now
    expect(utc.dau.human).toBe(1)
  })

  test('Los Angeles has its own day edges on the same instants', async () => {
    await seedFallBack()
    const la = await AC('America/Los_Angeles', FALLBACK_NOW)
    expect(la.zone).toBe('America/Los_Angeles')
    expect(la.perDay.at(-1)).toMatchObject({ day: '2026-11-01', human: 2, total: 2 }) // 00:00 PDT and 20:00 PST; 06:30Z is 23:30 PDT on Oct 31
    expect(la.perDay.at(-2)).toMatchObject({ day: '2026-10-31', total: 4 })
    expect(la.dau.human).toBe(2)
    expect(la.perDay[0]!.day).toBe('2026-10-03')
    expect(la.perDay[0]!.total).toBe(0) // 03:59Z and 04:00Z are Oct 2 evening in Los Angeles, before its window opens at 07:00Z
    expect(la.mau.human).toBe(6)
  })

  test('the session time zone changes nothing for a named zone, and nothing after now is counted', async () => {
    await seedFallBack()
    const want = { ny: await AC('America/New_York', FALLBACK_NOW), la: await AC('America/Los_Angeles', FALLBACK_NOW), ov: await OV('America/New_York', FALLBACK_NOW) }
    try {
      for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
        await client.exec(`set time zone '${tz}'`)
        expect(await AC('America/New_York', FALLBACK_NOW)).toEqual(want.ny)
        expect(await AC('America/Los_Angeles', FALLBACK_NOW)).toEqual(want.la)
        expect(await OV('America/New_York', FALLBACK_NOW)).toEqual(want.ov)
      }
    } finally {
      await client.exec("set time zone 'UTC'")
    }
    expect(want.ny.mau.human).toBe(7) // the two matches after now are not counted
  })

  test('the overview buckets matches and joins by the asked zone, and the parts still add up', async () => {
    await seedFallBack()
    const ny = await OV('America/New_York', FALLBACK_NOW)
    expect(ny.zone).toBe('America/New_York')
    expect(ny.matchesPerDay).toHaveLength(14)
    expect(ny.matchesPerDay.at(-1)).toMatchObject({ day: '2026-11-01' })
    expect(ny.matchesPerDay.at(-1)!.total).toBe(5) // the 04:59Z match is after now and not counted
    expect(ny.matchesPerDay.at(-2)!.total).toBe(1)
    for (const d of [...ny.matchesPerDay, ...ny.newPerDay]) addsUp(d)
    expect(new Set(ny.matchesPerDay.map((d) => d.day)).size).toBe(14)
    const utc = await OV('UTC', FALLBACK_NOW)
    expect(utc.matchesPerDay.at(-1)!.day).toBe('2026-11-02')
  })

  test('a bad, missing or hostile zone falls back to UTC, says so, and never reaches the SQL text', async () => {
    await seedFallBack()
    const utc = await AC('UTC', FALLBACK_NOW)
    expect(utc.zoneFallback).toBe(false)
    for (const bad of [undefined, null, '', 'Not/AZone', 42, { toString: () => 'UTC' }, 'UTC\'; drop table match; --', "x' || (select 1) || '", 'A'.repeat(500)]) {
      const a = (await adminActiveHandler(db, OWNER, ENV, FALLBACK_NOW, bad)).body as import('./admin-owner').ActiveUsers
      expect(a.zone).toBe('UTC')
      expect(a.zoneFallback).toBe(true)
      expect({ ...a, zoneFallback: false }).toEqual(utc)
      expect(((await adminOverviewHandler(db, OWNER, ENV, FALLBACK_NOW, bad)).body as import('./admin-owner').AdminOverview).zoneFallback).toBe(true)
    }
    expect((await client.query('select count(*)::int as n from match')).rows[0]).toEqual({ n: 10 })
  })

  test('404 for anyone but the owner is unchanged whatever zone they ask for', async () => {
    for (const who of [GUEST_VIEWER, OTHER]) {
      expect((await adminActiveHandler(db, who, ENV, NOW, 'America/New_York')).status).toBe(404)
      expect((await adminOverviewHandler(db, who, ENV, NOW, 'America/New_York')).status).toBe(404)
    }
  })
})
