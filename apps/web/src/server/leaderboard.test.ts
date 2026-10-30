import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { getLeaderboard, getShowOnLeaderboard, getUserRating, leaderboardViewHandler, setShowOnLeaderboard } from './leaderboard'
import { getSettings } from './profile'

let client: PGlite
let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table guest, rating, profile, "user" cascade`)
})

async function seed() {
  await db.insert(schema.user).values([
    { id: 'a', name: 'Ada Lovelace', email: 'a@x.test' },
    { id: 'b', name: 'Bo Peep', email: 'b@x.test' },
  ])
  await db.insert(schema.rating).values([
    { userId: 'a', game: 'four', elo: 1300, games: 9 },
    { userId: 'b', game: 'four', elo: 1100, games: 9 },
  ])
}

describe('leaderboard privacy (M3)', () => {
  test('a player is on the board by default', async () => {
    await seed()
    expect(await getShowOnLeaderboard(db, 'a')).toBe(true)
    expect((await getLeaderboard(db, 'four')).map((r) => r.name)).toEqual(['Ada', 'Bo'])
  })

  test('turning the switch off removes the player from the board and ranks close up; turning it on brings them back', async () => {
    await seed()
    await setShowOnLeaderboard(db, { userId: 'a' }, false)
    expect(await getShowOnLeaderboard(db, 'a')).toBe(false)
    const rows = await getLeaderboard(db, 'four')
    expect(rows.map((r) => [r.rank, r.name])).toEqual([[1, 'Bo']])
    await setShowOnLeaderboard(db, { userId: 'a' }, true)
    expect((await getLeaderboard(db, 'four')).map((r) => r.name)).toEqual(['Ada', 'Bo'])
  })

  test('the choice leaves the training setting alone, and creating the profile row keeps an opt-out carried from the guest', async () => {
    await seed()
    await db.insert(schema.guest).values({ id: 'g-1', trainingAllowed: false })
    await setShowOnLeaderboard(db, { userId: 'a', guestId: 'g-1' }, false)
    expect((await getSettings(db, { userId: 'a' })).trainingAllowed).toBe(false)
    await db.insert(schema.profile).values({ userId: 'b', trainingAllowed: true })
    await setShowOnLeaderboard(db, { userId: 'b' }, false)
    expect((await db.select().from(schema.profile).where(eq(schema.profile.userId, 'b')))[0]).toMatchObject({ trainingAllowed: true, showOnLeaderboard: false })
  })

  test('a user with no profile row (never opened settings) reads as shown', async () => {
    expect(await getShowOnLeaderboard(db, 'nobody')).toBe(true)
  })
})

describe('real-time games have no leaderboard (H1)', () => {
  test('ratings an earlier build wrote for the fighter or the arena never show, and the view says the game is unranked', async () => {
    await seed()
    await db.insert(schema.rating).values([
      { userId: 'a', game: 'fighter', elo: 1500, games: 20 },
      { userId: 'a', game: 'arena', elo: 1500, games: 20 },
    ])
    for (const g of ['fighter', 'arena'] as const) {
      expect(await getLeaderboard(db, g)).toEqual([])
      expect(await getUserRating(db, 'a', g)).toBeNull()
      const v = await leaderboardViewHandler(db, g, 'a', new Date(), async () => {})
      expect(v).toMatchObject({ rows: [], me: null, ranked: false })
    }
    expect(await leaderboardViewHandler(db, 'four', 'a', new Date(), async () => {})).toMatchObject({ ranked: true, me: { elo: 1300 } })
  })
})
