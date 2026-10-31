import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { resolveGuest } from './guest'
import { getSettings, setTrainingAllowed } from './profile'
import { getPokerProfileAllowed, setPokerProfileAllowed } from './poker-profile'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, guest, profile, rating`)
})

describe('Hold\'em play profile switch', () => {
  test('on by default for guests and accounts, and the choice persists', async () => {
    const g = await resolveGuest(db, null)
    expect(await getPokerProfileAllowed(db, { guestId: g.id })).toBe(true)
    expect(await getPokerProfileAllowed(db, { userId: 'u-1' })).toBe(true)
    await setPokerProfileAllowed(db, { guestId: g.id }, false)
    expect(await getPokerProfileAllowed(db, { guestId: g.id })).toBe(false)
    await setPokerProfileAllowed(db, { guestId: g.id }, true)
    expect(await getPokerProfileAllowed(db, { guestId: g.id })).toBe(true)
    await setPokerProfileAllowed(db, { userId: 'u-1' }, false)
    expect(await getPokerProfileAllowed(db, { userId: 'u-1' })).toBe(false)
    expect(await db.select().from(schema.profile).where(eq(schema.profile.userId, 'u-1'))).toHaveLength(1)
  })

  test('it does not touch the training switch, and the training switch does not touch it', async () => {
    const g = await resolveGuest(db, null)
    const who = { guestId: g.id }
    await setPokerProfileAllowed(db, who, false)
    expect((await getSettings(db, who)).trainingAllowed).toBe(true)
    await setPokerProfileAllowed(db, who, true)
    await setTrainingAllowed(db, who, false)
    expect(await getPokerProfileAllowed(db, who)).toBe(true)
  })

  test('a signed-in opt-out also switches off the guest row of this browser', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { userId: 'u-2', guestId: g.id }, false)
    expect((await db.select().from(schema.guest).where(eq(schema.guest.id, g.id)))[0]!.pokerProfileAllowed).toBe(false)
  })

  test('an opt-out made as a guest carries to a new account, and a new profile row keeps a carried training opt-out', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { guestId: g.id }, false)
    await setTrainingAllowed(db, { guestId: g.id }, false)
    expect(await getPokerProfileAllowed(db, { userId: 'u-3', guestId: g.id })).toBe(false)
    await setPokerProfileAllowed(db, { userId: 'u-3', guestId: g.id }, false)
    expect((await getSettings(db, { userId: 'u-3', guestId: g.id })).trainingAllowed).toBe(false)
  })

  test('an unknown guest changes nothing', async () => {
    await setPokerProfileAllowed(db, { guestId: 'nobody' }, false)
    expect(await db.select().from(schema.guest)).toHaveLength(0)
    expect(await getPokerProfileAllowed(db, { guestId: 'nobody' })).toBe(true)
  })
})
