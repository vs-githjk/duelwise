import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { signDuelResult, type DuelResultRecord } from '@duelwise/core/src/duel/result-proof'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { callerRef, playerKey } from './duel-token'
import { deleteAccount } from './account'
import { cardFrom, deleteFriendResults, friendsForViewer, recordFriendResult, type FriendDeps } from './friend-results'

type Db = PgliteDatabase<typeof schema>
let client: PGlite
let db: Db
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table friend_result, telemetry_event, match, rating`)
})

const SECRET = 'test-secret-at-least-16-chars-long'
const OTHER_SECRET = 'a-different-secret-16-chars-long'
const DEV_ADA = '3f2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a11'
const DEV_SAM = '4a2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a22'
const DEV_EVE = '5b2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a33'

interface Person { name: string; device: string; userId?: string }
const ada: Person = { name: 'Ada', device: DEV_ADA }
const sam: Person = { name: 'Sam', device: DEV_SAM }
const eve: Person = { name: 'Eve', device: DEV_EVE }

const depsFor = (p: Person, secret: string | undefined = SECRET): FriendDeps => ({ secret, viewer: async () => (p.userId ? { userId: p.userId } : {}) })
const who = async (p: Person) => ({ ref: await callerRef(SECRET, p.userId ? { userId: p.userId } : {}, p.device), pid: await playerKey(SECRET, p.userId ? { userId: p.userId } : {}, p.device) })

let n = 0
/** The proof the relay would sign for one finished game: `first` holds seat 0, `winner` is a seat or null. */
async function proof(first: Person, second: Person, winner: 0 | 1 | null, over: Partial<DuelResultRecord> = {}, game: DuelResultRecord['game'] = 'four', secret = SECRET) {
  const a = await who(first)
  const b = await who(second)
  const rec: DuelResultRecord = { id: `ABCDEF.1700000000000.${++n}`, game, at: 1_700_000_000_000 + n * 60_000, players: [{ ...a, name: first.name }, { ...b, name: second.name }], winner, ...over }
  return signDuelResult(rec, secret)
}

describe('head-to-head: two friends, three games', () => {
  test('Ada beats Sam twice and loses once: each sees the mirror of the other, and the rows hold result only', async () => {
    const proofs = [await proof(ada, sam, 0), await proof(sam, ada, 1), await proof(ada, sam, 1)]
    let last: any
    for (const pr of proofs) {
      const a = await recordFriendResult(db, depsFor(ada), { proof: pr, deviceId: DEV_ADA })
      const s = await recordFriendResult(db, depsFor(sam), { proof: pr, deviceId: DEV_SAM })
      expect(a.ok && s.ok).toBe(true)
      last = { a, s }
    }
    expect(last.a.card).toMatchObject({ friend: 'Sam', game: { you: 2, them: 1, draws: 0 }, all: { you: 2, them: 1, draws: 0 }, gamesPlayed: 1 })
    expect(last.s.card).toMatchObject({ friend: 'Ada', game: { you: 1, them: 2, draws: 0 } })
    const rows = await db.select().from(schema.friendResult)
    expect(rows.length).toBe(3)
    expect(Object.keys(rows[0]!).sort()).toEqual(['finishedAt', 'game', 'id', 'nameA', 'nameB', 'playerA', 'playerB', 'winner'])
    // no match row, no rating, one telemetry event per game
    expect((await db.select().from(schema.match)).length).toBe(0)
    expect((await db.select().from(schema.rating)).length).toBe(0)
    const tel = await db.select().from(schema.telemetryEvent)
    expect(tel.length).toBe(3)
    expect(tel.every((t) => t.kind === 'friend_match_finished' && t.optedOut && t.playerRef === 'friend' && t.outcome === null)).toBe(true)
  })

  test('both phones post the same proof: one row, one telemetry event, the second post just reads', async () => {
    const pr = await proof(ada, sam, null)
    await recordFriendResult(db, depsFor(ada), { proof: pr, deviceId: DEV_ADA })
    const again = await recordFriendResult(db, depsFor(sam), { proof: pr, deviceId: DEV_SAM })
    await recordFriendResult(db, depsFor(ada), { proof: pr, deviceId: DEV_ADA })
    expect(again.ok && again.card.game).toEqual({ you: 0, them: 0, draws: 1 })
    expect((await db.select().from(schema.friendResult)).length).toBe(1)
    expect((await db.select().from(schema.telemetryEvent)).length).toBe(1)
  })

  test('a draw has no winner key; the card counts it for both', async () => {
    await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, sam, null), deviceId: DEV_ADA })
    expect((await db.select().from(schema.friendResult))[0]!.winner).toBeNull()
  })

  test('the card keeps games apart: this game and all games', async () => {
    await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, sam, 0, {}, 'four'), deviceId: DEV_ADA })
    await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, sam, 1, {}, 'chess'), deviceId: DEV_ADA })
    const r = await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, sam, 0, {}, 'chess'), deviceId: DEV_ADA })
    if (!r.ok) throw new Error('refused')
    expect(r.card).toMatchObject({ game: { you: 1, them: 1, draws: 0 }, all: { you: 2, them: 1, draws: 0 }, gamesPlayed: 2 })
  })

  test('a signed-in person is keyed by account, so the record follows them to another phone', async () => {
    const adaIn: Person = { ...ada, userId: 'user-ada' }
    await recordFriendResult(db, depsFor(adaIn), { proof: await proof(adaIn, sam, 0), deviceId: DEV_ADA })
    const otherPhone: Person = { ...adaIn, device: '6c2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a44' }
    const r = await recordFriendResult(db, depsFor(otherPhone), { proof: await proof(otherPhone, sam, 1), deviceId: otherPhone.device })
    if (!r.ok) throw new Error('refused')
    expect(r.card.game).toEqual({ you: 1, them: 1, draws: 0 })
  })

  test('the ratings in the proof come back for the result screen, only the ones that exist', async () => {
    const a = await who(ada)
    const b = await who(sam)
    const pr = await signDuelResult({ id: 'ABCDEF.1700000000000.99', game: 'four', at: 1_700_000_000_000, players: [{ ...a, name: 'Ada', rating: 1240 }, { ...b, name: 'Sam' }], winner: 0 }, SECRET)
    const r = await recordFriendResult(db, depsFor(sam), { proof: pr, deviceId: DEV_SAM })
    expect(r.ok && r.ratings).toEqual({ them: 1240, friend: 'Ada' })
  })
})

describe('a result one client makes up is refused', () => {
  test('a proof edited by the client (winner flipped), signed with another secret, or not a proof at all writes nothing', async () => {
    const good = await proof(ada, sam, 1)
    const [body, sig] = good.split('.') as [string, string]
    const json = JSON.parse(Buffer.from(body, 'base64url').toString())
    const flipped = `${Buffer.from(JSON.stringify({ ...json, winner: 0 })).toString('base64url')}.${sig}`
    const wrong = await proof(ada, sam, 0, {}, 'four', OTHER_SECRET)
    for (const bad of [flipped, wrong, 'nonsense', '', null, undefined, { proof: good }, 42]) {
      expect(await recordFriendResult(db, depsFor(ada), { proof: bad, deviceId: DEV_ADA })).toEqual({ ok: false, error: 'bad-proof' })
    }
    expect((await db.select().from(schema.friendResult)).length).toBe(0)
    expect((await db.select().from(schema.telemetryEvent)).length).toBe(0)
  })

  test('someone who is not one of the two players cannot post or read it, even holding a real proof', async () => {
    const pr = await proof(ada, sam, 0)
    expect(await recordFriendResult(db, depsFor(eve), { proof: pr, deviceId: DEV_EVE })).toEqual({ ok: false, error: 'not-your-game' })
    // nor claim Ada's seat with Ada's device id from another account
    expect(await recordFriendResult(db, depsFor({ ...eve, userId: 'user-eve' }), { proof: pr, deviceId: DEV_ADA })).toEqual({ ok: false, error: 'not-your-game' })
    expect((await db.select().from(schema.friendResult)).length).toBe(0)
  })

  test('head-to-head is off without the signing secret, and a malformed device id is refused', async () => {
    const pr = await proof(ada, sam, 0)
    expect(await recordFriendResult(db, { ...depsFor(ada), secret: undefined }, { proof: pr, deviceId: DEV_ADA })).toEqual({ ok: false, error: 'unavailable' })
    expect(await recordFriendResult(db, depsFor(ada, 'short'), { proof: pr, deviceId: DEV_ADA })).toEqual({ ok: false, error: 'unavailable' })
    expect(await recordFriendResult(db, depsFor(ada), { proof: pr, deviceId: 'x' })).toEqual({ ok: false, error: 'bad-device' })
  })
})

describe('the friends list and deleting an account', () => {
  test('lists each person once with your record, newest first; a stranger has an empty list', async () => {
    await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, sam, 0), deviceId: DEV_ADA })
    await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, sam, 1), deviceId: DEV_ADA })
    await recordFriendResult(db, depsFor(ada), { proof: await proof(eve, ada, null), deviceId: DEV_ADA })
    const r = await friendsForViewer(db, depsFor(ada), { deviceId: DEV_ADA })
    if (!r.ok) throw new Error('refused')
    expect(r.friends.map((f) => [f.name, f.you, f.them, f.draws, f.games])).toEqual([['Eve', 0, 0, 1, 1], ['Sam', 1, 1, 0, 2]])
    const s = await friendsForViewer(db, depsFor(sam), { deviceId: DEV_SAM })
    expect(s.ok && s.friends.map((f) => [f.name, f.you, f.them])).toEqual([['Ada', 1, 1]])
    const none = await friendsForViewer(db, depsFor({ name: 'Zed', device: '7d2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a55' }), { deviceId: '7d2b1c9e-7a44-4d0e-9a51-0c6f2f0b1a55' })
    expect(none.ok && none.friends).toEqual([])
  })

  test('deleting an account removes every result the person is in', async () => {
    await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, sam, 0), deviceId: DEV_ADA })
    await recordFriendResult(db, depsFor(ada), { proof: await proof(ada, eve, 1), deviceId: DEV_ADA })
    await deleteFriendResults(db, (await who(sam)).pid)
    const left = await db.select().from(schema.friendResult)
    expect(left.length).toBe(1)
    expect(left[0]!.nameB).toBe('Eve')
    expect((await db.select().from(schema.friendResult).where(eq(schema.friendResult.game, 'four'))).length).toBe(1)
  })

  test('deleteAccount with the persons friend key removes their results and leaves the others', async () => {
    const adaIn: Person = { ...ada, userId: 'user-ada' }
    await db.insert(schema.user).values({ id: 'user-ada', name: 'Ada', email: 'ada@example.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() } as never)
    await recordFriendResult(db, depsFor(adaIn), { proof: await proof(adaIn, sam, 0), deviceId: DEV_ADA })
    await recordFriendResult(db, depsFor(sam), { proof: await proof(sam, eve, 1), deviceId: DEV_SAM })
    expect(await deleteAccount(db, 'user-ada', undefined, await playerKey(SECRET, { userId: 'user-ada' }, ''))).toBe(true)
    const left = await db.select().from(schema.friendResult)
    expect(left.map((r) => r.nameA + r.nameB).sort()).toEqual(['EveSam'])
  })

  test('cardFrom: an empty history is zeros', () => {
    expect(cardFrom([], 'me', 'four', 'Sam')).toEqual({ friend: 'Sam', game: { you: 0, them: 0, draws: 0 }, all: { you: 0, them: 0, draws: 0 }, gamesPlayed: 0 })
  })
})
