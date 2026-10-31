import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrateDb } from '../src/db/migrate'
import * as schema from '../src/db/schema'
import { backfill, type Query } from './backfill-traffic'

let client: PGlite
let q: Query
beforeAll(async () => {
  client = new PGlite()
  await migrateDb(drizzle(client, { schema }))
  q = async (text, params = []) => (await client.query(text, params)).rows as Array<Record<string, unknown>>
})
afterAll(() => client.close())

const G = (c: string) => `${c.repeat(8)}-1111-2222-3333-${c.repeat(12)}`
const match = (id: string, who: { user?: string; guest?: string }) =>
  q(`insert into match (id, game, user_id, guest_id, agent_version, level, seed, status) values ($1, 'four', $2, $3, 'v1', 'easy', 1, 'finished')`, [id, who.user ?? null, who.guest ?? null])
const tag = async (table: 'match' | 'guest', id: string) => (await q(`select traffic from ${table} where id = $1`, [id]))[0]!.traffic

beforeEach(async () => {
  await q(`truncate table match, guest, session, account, "user" cascade`, [])
  await q(`insert into "user" (id, name, email, email_verified) values ('u-own', 'Boss', 'Owner@Example.com', true), ('u-dev', 'x', 'bot@dev.invalid', true), ('u-real', 'Real Person', 'real@example.com', true), ('u-head', 'Hh', 'hh@example.com', true), ('u-fix', 'e2e-seed-player', 'f@example.com', true)`, [])
  await q(`insert into session (id, expires_at, token, user_id, user_agent) values ('s1', now(), 't1', 'u-head', 'Mozilla/5.0 HeadlessChrome/120'), ('s2', now(), 't2', 'u-real', 'Mozilla/5.0 Safari/605')`, [])
  await q(`insert into guest (id, display_name) values ($1, 'E2E-adm-player'), ($2, 'Wren'), ($3, null)`, [G('a'), G('b'), G('c')])
  await match('m-own', { user: 'u-own' })
  await match('m-dev', { user: 'u-dev' })
  await match('m-real', { user: 'u-real' })
  await match('m-head', { user: 'u-head' })
  await match('m-fix', { user: 'u-fix' })
  await match('m-gt', { guest: G('a') })
  await match('m-gh', { guest: G('b') })
  await match('m-gn', { guest: G('c') })
})

describe('backfill-traffic', () => {
  test('a dry run counts each proposed class and writes nothing', async () => {
    const plan = await backfill(q, { owners: ['owner@example.com'], apply: false })
    expect(plan).toEqual({ ownerAccounts: 1, ownerMatches: 1, testGuests: 1, testAccounts: 3, testMatches: 4, unchangedMatches: 3 })
    expect((await q(`select count(*)::int as n from match where traffic is not null`, []))[0]!.n).toBe(0)
    expect((await q(`select count(*)::int as n from guest where traffic is not null`, []))[0]!.n).toBe(0)
  })

  test('--apply tags owner accounts, fixture and headless players, and leaves everyone else null', async () => {
    await backfill(q, { owners: ['owner@example.com'], apply: true })
    expect(await tag('match', 'm-own')).toBe('owner')
    for (const id of ['m-dev', 'm-head', 'm-fix', 'm-gt']) expect(await tag('match', id)).toBe('test')
    for (const id of ['m-real', 'm-gh', 'm-gn']) expect(await tag('match', id)).toBeNull()
    expect(await tag('guest', G('a'))).toBe('test')
    expect(await tag('guest', G('b'))).toBeNull()
    // Running it again changes nothing, and a tag the server wrote is never overridden.
    await q(`update match set traffic = 'human' where id = 'm-dev'`, [])
    const again = await backfill(q, { owners: ['owner@example.com'], apply: true })
    expect(await tag('match', 'm-dev')).toBe('human')
    expect(again.ownerMatches).toBe(0)
  })

  test('no owners listed means no owner is proposed, and an owner is never also test', async () => {
    expect((await backfill(q, { owners: [], apply: false })).ownerAccounts).toBe(0)
    await q(`insert into session (id, expires_at, token, user_id, user_agent) values ('s3', now(), 't3', 'u-own', 'HeadlessChrome')`, [])
    await backfill(q, { owners: ['owner@example.com'], apply: true })
    expect(await tag('match', 'm-own')).toBe('owner')
  })
})
