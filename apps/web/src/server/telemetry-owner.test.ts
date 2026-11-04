import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { ownerViewHandler, parseOwnerParams, revealEmailsHandler } from './telemetry-owner'
import { playerRef } from './telemetry'
import type { OwnerView } from './telemetry-stats'

type Db = PgliteDatabase<typeof schema>
let client: PGlite
let db: Db
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())

const NOW = new Date('2026-10-22T12:00:00.000Z')
const ENV = { OWNER_EMAILS: 'owner@example.com' }
const OWNER = { id: 'u-owner', email: 'owner@example.com', emailVerified: true }
const OTHER = { id: 'u-other', email: 'other@example.com' }

beforeEach(async () => {
  await db.execute(sql`truncate table telemetry_event, owner_audit, account, "user" cascade`)
  await db.insert(schema.user).values([
    { id: 'u-1', name: 'Ada', email: 'ada@example.com' },
    { id: OWNER.id, name: 'Owner', email: OWNER.email },
  ])
  await db.insert(schema.account).values({ id: 'a-1', accountId: 'x', providerId: 'google', userId: 'u-1' })
  const ref = await playerRef('user', 'u-1')
  const row = (kind: schema.TelemetryKind, matchId: string, minutesAgo: number, extra: Partial<typeof schema.telemetryEvent.$inferInsert> = {}) => ({
    id: crypto.randomUUID(), at: new Date(NOW.getTime() - minutesAgo * 60_000), kind, matchId, game: 'chess', level: 'easy', persona: 'Pip',
    device: 'phone', trainingBasis: 'legitimate-interest', playerRef: ref, playerKind: 'user', ...extra,
  })
  await db.insert(schema.telemetryEvent).values([
    row('match_started', 'm1', 30),
    row('match_finished', 'm1', 20, { outcome: 'human', durationMs: 600_000 }),
  ])
})

describe('owner view time zone', () => {
  const get = async (q: Record<string, unknown>) => (await ownerViewHandler(db, OWNER, ENV, q, () => null, NOW)).body as import('./telemetry-stats').OwnerViewBody
  test('the asked zone is validated, echoed and used; a missing or hostile one falls back to UTC and says so', async () => {
    expect(await get({ tz: 'America/New_York' })).toMatchObject({ zone: 'America/New_York', zoneFallback: false, zoneAsked: true })
    expect(await get({})).toMatchObject({ zone: 'UTC', zoneFallback: true, zoneAsked: false })
    expect(await get({ tz: "UTC'; drop table telemetry_event; --" })).toMatchObject({ zone: 'UTC', zoneFallback: true, zoneAsked: true })
    expect(await get({ tz: 7 })).toMatchObject({ zone: 'UTC', zoneFallback: true })
    expect((await get({ tz: 'UTC' })).zoneFallback).toBe(false)
    expect((await client.query('select count(*)::int as n from telemetry_event')).rows[0]).toEqual({ n: 2 })
  })
})

describe('owner view previous period reaches back far enough', () => {
  test('an event in the first half hour of the previous 7 days after a 25 hour day is fetched and counted', async () => {
    const now = new Date('2026-11-02T04:30:00.000Z') // 23:30 EST Nov 1; the previous period opens Oct 19 00:00 EDT = 04:00Z
    await db.insert(schema.telemetryEvent).values(['match_started', 'match_finished'].map((kind) => ({
      id: crypto.randomUUID(), at: new Date('2026-10-19T04:10:00.000Z'), kind: kind as schema.TelemetryKind, matchId: 'gap', game: 'chess', level: 'easy', persona: 'Pip',
      device: 'phone', trainingBasis: 'legitimate-interest', playerRef: 'pl_gap', playerKind: 'user', ...(kind === 'match_finished' ? { outcome: 'human', durationMs: 1000 } : {}),
    })))
    const body = (await ownerViewHandler(db, OWNER, ENV, { range: '7d', tz: 'America/New_York', who: 'all' }, () => null, now)).body as import('./telemetry-stats').OwnerViewBody
    expect(body.kpis.matches.previous).toBe(2) // the match seeded on Oct 22 plus the one in the gap
  })
})

describe('owner view access', () => {
  test('a non-owner, a signed-out visitor and a missing allowlist all get 404 and no data', async () => {
    // The allowlisted email with the address not verified by the provider is not the owner either (M4).
    const UNVERIFIED = { ...OWNER, emailVerified: false }
    for (const [user, env] of [[OTHER, ENV], [null, ENV], [OWNER, {}], [UNVERIFIED, ENV]] as const) {
      const r = await ownerViewHandler(db, user, env, {}, () => null, NOW)
      expect(r).toEqual({ status: 404, body: { error: 'not found' } })
    }
  })

  test('the owner gets the view built from stored events, with the sign-in provider', async () => {
    const r = await ownerViewHandler(db, OWNER, ENV, { range: '7d' }, () => null, NOW)
    expect(r.status).toBe(200)
    if (r.status !== 200) return
    const body = r.body as OwnerView
    expect(body.kpis.matches.value).toBe(1)
    expect(body.whoPlayed[0]).toMatchObject({ player: await playerRef('user', 'u-1'), provider: 'google', wins: 1 })
    expect(JSON.stringify(body)).not.toContain('ada@example.com')
  })

  test('query params are validated to known values', () => {
    expect(parseOwnerParams({ range: '30d', game: 'chess', level: 'hard', page: '2' })).toEqual({ range: '30d', game: 'chess', level: 'hard', page: 2, who: 'human' })
    expect(parseOwnerParams({ range: 'bogus', game: 'nope', level: 'x', page: '-4' })).toEqual({ range: '7d', game: undefined, level: undefined, page: 0, who: 'human' })
  })
})

describe('email reveal', () => {
  test('an unverified email on the allowlist cannot reveal emails', async () => {
    const r = await revealEmailsHandler(db, { ...OWNER, emailVerified: false }, ENV, { refs: [] }, NOW)
    expect(r.status).toBe(404)
  })

  test('is owner only', async () => {
    const r = await revealEmailsHandler(db, OTHER, ENV, { refs: [await playerRef('user', 'u-1')] }, NOW)
    expect(r.status).toBe(404)
    expect(await db.select().from(schema.ownerAudit)).toHaveLength(0)
  })

  test('returns the email of the asked players and logs one audit row per player', async () => {
    const ref = await playerRef('user', 'u-1')
    const r = await revealEmailsHandler(db, OWNER, ENV, { refs: [ref, 'pl_unknown', 'junk'] }, NOW)
    expect(r.status).toBe(200)
    expect((r.body as { emails: Record<string, string> }).emails).toEqual({ [ref]: 'ada@example.com' })
    const audit = await db.select().from(schema.ownerAudit)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'reveal_email', targetRef: ref, ownerRef: await playerRef('user', OWNER.id) })
  })

  test('refuses an oversized request', async () => {
    const refs = Array.from({ length: 101 }, (_, i) => `pl_${String(i).padStart(8, '0')}`)
    expect((await revealEmailsHandler(db, OWNER, ENV, { refs }, NOW)).status).toBe(400)
  })
})
