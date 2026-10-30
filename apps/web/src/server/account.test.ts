import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { deleteAccount } from './account'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, match_report, guest, profile, rating, session, account, verification, "user" cascade`)
})

async function seedUser(id: string) {
  await db.insert(schema.user).values({ id, name: id, email: `${id}@example.test` })
  await db.insert(schema.session).values({ id: `s-${id}`, token: `t-${id}`, userId: id, expiresAt: new Date(Date.now() + 1e6) })
  await db.insert(schema.account).values({ id: `a-${id}`, accountId: id, providerId: 'github', userId: id })
  await db.insert(schema.verification).values({ id: `v-${id}`, identifier: `${id}@example.test`, value: 'x', expiresAt: new Date(Date.now() + 1e6) })
  await db.insert(schema.profile).values({ userId: id })
  await db.insert(schema.rating).values([
    { userId: id, game: 'four', elo: 1210, games: 3 },
    { userId: id, game: 'chess', elo: 1190, games: 1 },
  ])
  await db.insert(schema.match).values([
    { id: `m1-${id}`, game: 'four', userId: id, agentVersion: 'v1', level: 'easy', seed: 1 },
    { id: `m2-${id}`, game: 'chess', userId: id, agentVersion: 'v1', level: 'hard', seed: 2, status: 'finished' },
  ])
}

describe('deleteAccount', () => {
  test('removes the user, sessions, ratings, profile and matches, and nothing of anyone else', async () => {
    await seedUser('ada')
    await seedUser('bob')
    const removed = await deleteAccount(db, 'ada')
    expect(removed).toBe(true)
    const ids = async (t: any, col: any) => (await db.select({ c: col }).from(t)).map((r: any) => r.c)
    expect(await ids(schema.user, schema.user.id)).toEqual(['bob'])
    expect(await ids(schema.session, schema.session.userId)).toEqual(['bob'])
    expect(await ids(schema.account, schema.account.userId)).toEqual(['bob'])
    expect(await ids(schema.verification, schema.verification.identifier)).toEqual(['bob@example.test'])
    expect(await ids(schema.profile, schema.profile.userId)).toEqual(['bob'])
    expect(await ids(schema.rating, schema.rating.userId)).toEqual(['bob', 'bob'])
    expect(await ids(schema.match, schema.match.userId)).toEqual(['bob', 'bob'])
  })

  test('also removes matches this browser played as a guest before signing in, but not other guests', async () => {
    await seedUser('ada')
    await db.insert(schema.guest).values([{ id: 'g-ada' }, { id: 'g-other' }])
    await db.insert(schema.match).values([
      { id: 'mg1', game: 'four', guestId: 'g-ada', agentVersion: 'v1', level: 'easy', seed: 3 },
      { id: 'mg2', game: 'four', guestId: 'g-other', agentVersion: 'v1', level: 'easy', seed: 4 },
    ])
    await deleteAccount(db, 'ada', 'g-ada')
    expect((await db.select().from(schema.match)).map((m) => m.id)).toEqual(['mg2'])
    expect((await db.select().from(schema.guest)).map((g) => g.id).sort()).toEqual(['g-ada', 'g-other'])
  })

  test('removes the match reports of the matches it deletes, and no one else\'s', async () => {
    await seedUser('ada')
    await seedUser('bob')
    await db.insert(schema.guest).values({ id: 'g-ada' })
    await db.insert(schema.match).values({ id: 'mg1', game: 'four', guestId: 'g-ada', agentVersion: 'v1', level: 'easy', seed: 3 })
    await db.insert(schema.matchReport).values(['m1-ada', 'm2-ada', 'mg1', 'm1-bob'].map((matchId) => ({ matchId })))
    await deleteAccount(db, 'ada', 'g-ada')
    expect((await db.select().from(schema.matchReport)).map((r) => r.matchId)).toEqual(['m1-bob'])
  })

  test('an unknown user changes nothing and returns false', async () => {
    await seedUser('ada')
    expect(await deleteAccount(db, 'nobody')).toBe(false)
    expect(await db.select().from(schema.match)).toHaveLength(2)
  })
})
