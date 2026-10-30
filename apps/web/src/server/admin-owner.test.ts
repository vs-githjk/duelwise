import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { adminActiveHandler, adminOverviewHandler, adminPeopleHandler, adminPlayerHandler, parsePeopleParams, type PlayerDetail } from './admin-owner'
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
    expect(o.matchesPerDay.reduce((s, d) => s + d.total, 0)).toBe(6) // the resigned match is not a finished one
    expect(o.matchesPerGame.find((g) => g.game === 'word')!.total).toBe(4)
    expect(o.matchesPerGame.find((g) => g.game === 'chess')!.total).toBe(1)
    expect(o.matchesPerGame.find((g) => g.game === 'four')!.total).toBe(0)
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


const OV = async (): Promise<import('./admin-owner').AdminOverview> => (await adminOverviewHandler(db, OWNER, ENV, NOW)).body as import('./admin-owner').AdminOverview
const AC = async (): Promise<import('./admin-owner').ActiveUsers> => (await adminActiveHandler(db, OWNER, ENV, NOW)).body as import('./admin-owner').ActiveUsers
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
  test('DAU, WAU, MAU and returning count distinct players across guests and accounts, by UTC day', async () => {
    // Seed: Wren finished matches on days 3,2,1; guest 0042 one today; Ada arena today and word 4 days ago. All human.
    const a = await AC()
    expect([a.dau.human, a.wau.human, a.mau.human, a.returning7.human, a.returning30.human]).toEqual([2, 3, 3, 2, 2])
    expect(a.perDay).toHaveLength(30)
    expect(a.perDay.at(-1)).toMatchObject({ day: '2026-10-30', human: 2, total: 2 })
    expect(a.perDay.find((d) => d.day === '2026-10-29')!.total).toBe(1)
    expect(a.perDay.reduce((s, d) => s + d.total, 0)).toBe(6)
  })

  test('the windows are UTC days: 8 days ago is in MAU only, 00:00 today is in DAU', async () => {
    await put({ guestId: G3, win: true, when: days(8) })
    await put({ guestId: G3, win: true, when: new Date('2026-10-30T00:00:00.000Z') })
    await put({ guestId: G3, win: true, when: new Date('2026-10-29T23:59:59.000Z') })
    const a = await AC()
    expect(a.dau.total).toBe(3)
    expect(a.mau.total).toBe(4)
    expect(a.returning30.total).toBe(3)
  })

  test('unfinished matches and empty history count nobody', async () => {
    await db.execute(sql`truncate table match cascade`)
    await put({ guestId: G1, status: 'resigned' })
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
    expect((await AC()).dau).toEqual({ human: 1, owner: 1, test: 0, total: 2 })
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
    expect(o.matchesPerDay.reduce((n, d) => n + d.total, 0)).toBe(8)
    expect(o.matchesPerGame.reduce((n, g) => n + g.total, 0)).toBe(8)
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
