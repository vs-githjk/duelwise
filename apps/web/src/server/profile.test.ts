import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { defaultTrainingAllowed, getSettings, markNoticeSeen, setTrainingAllowed } from './profile'
import { resolveGuest } from './guest'
import { startMatchHandler } from './match-handlers'

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

describe('defaults follow the training data basis', () => {
  test('legitimate interest is on by default, opt-in is off', () => {
    expect(defaultTrainingAllowed('legitimate-interest')).toBe(true)
    expect(defaultTrainingAllowed('opt-in')).toBe(false)
  })
})

describe('settings for a guest', () => {
  test('on by default, notice unseen; the toggle and the notice persist', async () => {
    const g = await resolveGuest(db, null)
    const who = { guestId: g.id }
    expect(await getSettings(db, who)).toEqual({ trainingAllowed: true, noticeSeen: false, signedIn: false })
    await setTrainingAllowed(db, who, false)
    await markNoticeSeen(db, who)
    expect(await getSettings(db, who)).toEqual({ trainingAllowed: false, noticeSeen: true, signedIn: false })
    await setTrainingAllowed(db, who, true)
    expect((await getSettings(db, who)).trainingAllowed).toBe(true)
  })

  test('an unknown guest id changes nothing and reads as defaults', async () => {
    const who = { guestId: 'nobody' }
    await setTrainingAllowed(db, who, false)
    expect(await getSettings(db, who)).toEqual({ trainingAllowed: true, noticeSeen: false, signedIn: false })
    expect(await db.select().from(schema.guest)).toHaveLength(0)
  })
})

describe('settings for a signed-in user', () => {
  test('a profile row is created on first write and persists', async () => {
    const who = { userId: 'u-1' }
    expect(await getSettings(db, who)).toEqual({ trainingAllowed: true, noticeSeen: false, signedIn: true })
    await setTrainingAllowed(db, who, false)
    await markNoticeSeen(db, who)
    expect(await getSettings(db, who)).toEqual({ trainingAllowed: false, noticeSeen: true, signedIn: true })
    expect(await db.select().from(schema.profile).where(eq(schema.profile.userId, 'u-1'))).toHaveLength(1)
  })

  test('marking the notice seen keeps the chosen toggle', async () => {
    const who = { userId: 'u-2' }
    await setTrainingAllowed(db, who, false)
    await markNoticeSeen(db, who)
    expect((await getSettings(db, who)).trainingAllowed).toBe(false)
  })
})

describe('opting out reaches matches', () => {
  test('new matches carry the choice, and opting out also clears the owner\'s earlier matches', async () => {
    const g = await resolveGuest(db, null)
    const who = { guestId: g.id }
    const first = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, who)
    expect(first.status).toBe(200)
    await setTrainingAllowed(db, who, false)
    const rows = await db.select().from(schema.match)
    expect(rows.every((r) => r.trainingAllowed === false)).toBe(true)
    const second = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, who)
    expect(second.status).toBe(200)
    expect((await db.select().from(schema.match)).every((r) => r.trainingAllowed === false)).toBe(true)
    // Opting back in applies to matches from now on, never to the ones already cleared.
    await setTrainingAllowed(db, who, true)
    await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, who)
    const flags = (await db.select().from(schema.match)).map((r) => r.trainingAllowed).sort()
    expect(flags).toEqual([false, false, true])
  })

  test('another player\'s matches are untouched', async () => {
    const a = await resolveGuest(db, null)
    const b = await resolveGuest(db, null)
    await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, { guestId: a.id })
    await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, { guestId: b.id })
    await setTrainingAllowed(db, { guestId: a.id }, false)
    const rows = await db.select().from(schema.match)
    expect(rows.find((r) => r.guestId === b.id)!.trainingAllowed).toBe(true)
    expect(rows.find((r) => r.guestId === a.id)!.trainingAllowed).toBe(false)
  })
})

describe('opt-out across guest and sign-in', () => {
  test('a user opting out also clears matches the same browser played as a guest', async () => {
    const g = await resolveGuest(db, null)
    await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, { guestId: g.id })
    await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, { userId: 'u-1', guestId: g.id })
    await setTrainingAllowed(db, { userId: 'u-1', guestId: g.id }, false)
    const rows = await db.select().from(schema.match)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.trainingAllowed === false)).toBe(true)
  })

  test('another guest\'s matches survive a user opt-out', async () => {
    const mine = await resolveGuest(db, null)
    const other = await resolveGuest(db, null)
    await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, { guestId: other.id })
    await setTrainingAllowed(db, { userId: 'u-1', guestId: mine.id }, false)
    expect((await db.select().from(schema.match))[0]!.trainingAllowed).toBe(true)
  })

  test('a guest opt-out carries to the profile created at sign-in, in settings, new matches and both writers', async () => {
    const g = await resolveGuest(db, null)
    await setTrainingAllowed(db, { guestId: g.id }, false)
    const who = { userId: 'u-1', guestId: g.id }
    expect((await getSettings(db, who)).trainingAllowed).toBe(false)
    await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, who)
    expect((await db.select().from(schema.match))[0]!.trainingAllowed).toBe(false)
    await markNoticeSeen(db, who)
    expect((await db.select().from(schema.profile))[0]!.trainingAllowed).toBe(false)
  })

  test('a guest opt-in is never carried: the profile uses the default', async () => {
    const g = await resolveGuest(db, null)
    await setTrainingAllowed(db, { guestId: g.id }, true)
    expect((await getSettings(db, { userId: 'u-1', guestId: g.id })).trainingAllowed).toBe(defaultTrainingAllowed())
  })

  test('an existing profile is not overridden by the guest row', async () => {
    const g = await resolveGuest(db, null)
    await setTrainingAllowed(db, { userId: 'u-1' }, true)
    await setTrainingAllowed(db, { guestId: g.id }, false)
    expect((await getSettings(db, { userId: 'u-1', guestId: g.id })).trainingAllowed).toBe(true)
  })
})
