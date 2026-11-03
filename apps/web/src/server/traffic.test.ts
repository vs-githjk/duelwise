import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { resolveGuest } from './guest'
import { startMatchHandler } from './match-handlers'
import { isTestRequest, requestTraffic } from './traffic'

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HEADLESS = CHROME.replace('Chrome/', 'HeadlessChrome/')

describe('request class', () => {
  test('a headless browser, the dw_test cookie and the x-dw-test header are test traffic; a normal browser is not', () => {
    expect(isTestRequest({ userAgent: HEADLESS })).toBe(true)
    expect(isTestRequest({ userAgent: CHROME, cookie: 'dw_guest=abc; dw_test=1' })).toBe(true)
    expect(isTestRequest({ userAgent: CHROME, testHeader: '1' })).toBe(true)
    expect(isTestRequest({ userAgent: CHROME, cookie: 'dw_test=0' })).toBe(false)
    expect(isTestRequest({ userAgent: CHROME, cookie: 'xdw_test=1', testHeader: '0' })).toBe(false)
    expect(isTestRequest({ userAgent: CHROME })).toBe(false)
    expect(isTestRequest({})).toBe(false)
  })
  test('the owner is the owner even from a script; otherwise test, otherwise human', () => {
    expect(requestTraffic({ userAgent: HEADLESS, owner: true })).toBe('owner')
    expect(requestTraffic({ userAgent: HEADLESS, owner: false })).toBe('test')
    expect(requestTraffic({ userAgent: CHROME, owner: true })).toBe('owner')
    expect(requestTraffic({ userAgent: CHROME, owner: false })).toBe('human')
  })
})

describe('written at create time', () => {
  let client: PGlite
  let db: PgliteDatabase<typeof schema>
  beforeAll(async () => {
    client = new PGlite()
    db = drizzle(client, { schema })
    await migrateDb(db)
  })
  afterAll(() => client.close())
  beforeEach(async () => {
    await db.execute(sql`truncate table match, guest, telemetry_event cascade`)
  })

  test('a new guest carries the class of its first request; an existing one is left alone', async () => {
    const t = await resolveGuest(db, null, false, 'test')
    const h = await resolveGuest(db, null, false, 'human')
    const legacy = await resolveGuest(db, null)
    const rows = await db.select().from(schema.guest)
    expect(rows.find((r) => r.id === t.id)!.traffic).toBe('test')
    expect(rows.find((r) => r.id === h.id)!.traffic).toBe('human')
    expect(rows.find((r) => r.id === legacy.id)!.traffic).toBeNull()
    await resolveGuest(db, `dw_guest=${t.id}`, false, 'human')
    expect((await db.select().from(schema.guest).where(eq(schema.guest.id, t.id)))[0]!.traffic).toBe('test')
  })

  test('a started match carries its caller class, and none is written when the caller does not say', async () => {
    await db.insert(schema.guest).values({ id: 'g-1' })
    for (const traffic of ['test', 'owner', 'human'] as const) {
      const r = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, { guestId: 'g-1', traffic })
      expect(r.status).toBe(200)
      const id = (r.body as { matchId: string }).matchId
      expect((await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!.traffic).toBe(traffic)
    }
    const r = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, { guestId: 'g-1' })
    expect((await db.select().from(schema.match).where(eq(schema.match.id, (r.body as { matchId: string }).matchId)))[0]!.traffic).toBeNull()
  })
})
