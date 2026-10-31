import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { resolveGuest } from './guest'
import { getSettings, setTrainingAllowed } from './profile'
import { carryPokerOptOutAtSignIn, getPokerProfileAllowed, setPokerProfileAllowed } from './poker-profile'

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

  test('a guest opt-out is carried into an account row that already exists, and opting back in clears both', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { userId: 'u-9' }, true) // the account row exists and says on
    await setPokerProfileAllowed(db, { guestId: g.id }, false) // then this browser, as a guest, opts out
    await carryPokerOptOutAtSignIn(db, 'u-9', g.id) // and signs in
    expect(await getPokerProfileAllowed(db, { userId: 'u-9', guestId: g.id })).toBe(false)
    expect((await db.select().from(schema.profile).where(eq(schema.profile.userId, 'u-9')))[0]!.pokerProfileAllowed).toBe(false)
    expect(await getPokerProfileAllowed(db, { userId: 'u-9' })).toBe(false) // stays off without the guest too
    await setPokerProfileAllowed(db, { userId: 'u-9', guestId: g.id }, true)
    expect(await getPokerProfileAllowed(db, { userId: 'u-9', guestId: g.id })).toBe(true)
  })

  const accountRow = async (userId: string) => (await db.select().from(schema.profile).where(eq(schema.profile.userId, userId)))[0]
  const guestRow = async (id: string) => (await db.select().from(schema.guest).where(eq(schema.guest.id, id)))[0]!

  test('a guest opt-out is written to an account with no profile row at sign-in, so an account-only read says off', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { guestId: g.id }, false)
    await carryPokerOptOutAtSignIn(db, 'u-10', g.id)
    expect((await accountRow('u-10'))?.pokerProfileAllowed).toBe(false)
    expect(await getPokerProfileAllowed(db, { userId: 'u-10' })).toBe(false)
  })

  test('the new row keeps a training opt-out carried from the guest, and carrying twice changes nothing', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { guestId: g.id }, false)
    await setTrainingAllowed(db, { guestId: g.id }, false)
    await carryPokerOptOutAtSignIn(db, 'u-11', g.id)
    await carryPokerOptOutAtSignIn(db, 'u-11', g.id)
    expect(await accountRow('u-11')).toMatchObject({ pokerProfileAllowed: false, trainingAllowed: false })
    expect(await db.select().from(schema.profile).where(eq(schema.profile.userId, 'u-11'))).toHaveLength(1)
  })

  test('an account already off switches off the guest row at sign-in, so the matches this browser played as a guest are out too', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { userId: 'u-12' }, false) // off from another device
    await carryPokerOptOutAtSignIn(db, 'u-12', g.id)
    expect((await guestRow(g.id)).pokerProfileAllowed).toBe(false)
    expect((await accountRow('u-12'))?.pokerProfileAllowed).toBe(false)
  })

  test('with no opt-out on either side, sign-in writes nothing', async () => {
    const g = await resolveGuest(db, null)
    await carryPokerOptOutAtSignIn(db, 'u-13', g.id)
    await carryPokerOptOutAtSignIn(db, 'u-13', undefined)
    await carryPokerOptOutAtSignIn(db, 'u-13', 'no-such-guest')
    expect(await accountRow('u-13')).toBeUndefined()
    expect((await guestRow(g.id)).pokerProfileAllowed).toBe(true)
  })

  test('an account that opted back in on this browser stays on across the next sign-in', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { guestId: g.id }, false)
    await carryPokerOptOutAtSignIn(db, 'u-14', g.id)
    await setPokerProfileAllowed(db, { userId: 'u-14', guestId: g.id }, true)
    await carryPokerOptOutAtSignIn(db, 'u-14', g.id)
    expect(await getPokerProfileAllowed(db, { userId: 'u-14' })).toBe(true)
  })

  test('reading the switch never writes: not a row, not a change, and the opt-out still wins in the answer', async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { guestId: g.id }, false)
    expect(await getPokerProfileAllowed(db, { userId: 'u-15', guestId: g.id })).toBe(false)
    expect(await accountRow('u-15')).toBeUndefined()
    await setPokerProfileAllowed(db, { userId: 'u-16' }, true)
    expect(await getPokerProfileAllowed(db, { userId: 'u-16', guestId: g.id })).toBe(false)
    expect((await accountRow('u-16'))?.pokerProfileAllowed).toBe(true)
  })
})
