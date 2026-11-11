import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { deleteAccount, friendKeysFor } from './account'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table friend_result, match, match_report, guest, profile, rating, session, account, verification, "user" cascade`)
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

describe('deleteAccount and head-to-head records', () => {
  const SECRET = 'test-secret-0123456789abcdef'
  const DEVICE = '11111111-2222-4333-8444-555555555555'
  const row = (id: string, a: string, b: string) => ({ id, game: 'four', playerA: a, playerB: b, nameA: 'A', nameB: 'B', winner: null, finishedAt: new Date() })

  test('succeeds when migration 0009 is not applied yet (no friend_result table) and removes the user', async () => {
    await seedUser('ada')
    await db.execute(sql`drop table friend_result`)
    try {
      expect(await deleteAccount(db, 'ada', undefined, ['some-key'])).toBe(true)
      expect(await db.select().from(schema.user)).toHaveLength(0)
    } finally {
      // Put the table back for the tests that follow.
      await db.execute(sql`create table friend_result (id text primary key, game text not null, player_a text not null, player_b text not null, name_a text not null, name_b text not null, winner text, finished_at timestamptz not null)`)
    }
  })

  test('also removes the rows kept under this device key (games played signed out), and leaves other devices alone', async () => {
    await seedUser('ada')
    const [acct, dev] = await friendKeysFor(SECRET, 'ada', DEVICE)
    const other = (await friendKeysFor(SECRET, 'bob', '99999999-2222-4333-8444-555555555555'))[1]!
    expect(acct).not.toBe(dev)
    await db.insert(schema.friendResult).values([row('r1', acct!, 'x'), row('r2', 'y', dev!), row('r3', 'x', other)])
    expect(await deleteAccount(db, 'ada', undefined, await friendKeysFor(SECRET, 'ada', DEVICE))).toBe(true)
    expect((await db.select().from(schema.friendResult)).map((r) => r.id)).toEqual(['r3'])
  })

  test('friendKeysFor: no secret or a short one gives no keys; a bad device id gives the account key only', async () => {
    expect(await friendKeysFor(undefined, 'ada', DEVICE)).toEqual([])
    expect(await friendKeysFor('short', 'ada', DEVICE)).toEqual([])
    expect(await friendKeysFor(SECRET, 'ada', 'nope')).toHaveLength(1)
    expect(await friendKeysFor(SECRET, 'ada', undefined)).toHaveLength(1)
  })
})
