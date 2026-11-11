import { createServerFn } from '@tanstack/react-start'
import { viewerFromRequest } from './caller'
import { getServerDb } from './server-db'
import { getIdentity } from './identity'
import { and, eq, gt, inArray } from 'drizzle-orm'
import type { GameId } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { CHALLENGE_GAMES, createChallenge, joinChallenge, newRoomCode, type ChallengeDeps, type Minted } from './duel-token'
import { friendsForViewer, recordFriendResult, type FriendDeps, type FriendRow, type RecordResult } from './friend-results'

/**
 * Friend challenges. Both functions only READ (who is looking, the name they saved) and return a signed token for the relay;
 * neither writes a row. They never create a guest or set a cookie. DUEL_SIGNING_SECRET is read here, on the server, and never leaves it.
 */
function liveDeps(): ChallengeDeps {
  return {
    secret: process.env.DUEL_SIGNING_SECRET,
    now: () => Date.now(),
    code: newRoomCode,
    viewer: () => viewerFromRequest(),
    savedName: async (who) => {
      if (!who.userId && !who.guestId) return null
      const { db } = await getServerDb()
      return (await getIdentity(db, who)).name
    },
    // One small read, and only for a signed-in person: the ratings they already earned against the AI, shown to their friend on the result.
    ratings: async (who) => {
      if (!who.userId) return {}
      const { db } = await getServerDb()
      const rows = await db
        .select({ game: schema.rating.game, elo: schema.rating.elo })
        .from(schema.rating)
        .where(and(eq(schema.rating.userId, who.userId), gt(schema.rating.games, 0), inArray(schema.rating.game, [...CHALLENGE_GAMES])))
      return Object.fromEntries(rows.map((r) => [r.game as GameId, r.elo]))
    },
  }
}

function friendDeps(): FriendDeps {
  return { secret: process.env.DUEL_SIGNING_SECRET, viewer: () => viewerFromRequest() }
}

const inputOf = (d: unknown): Record<string, unknown> => (d && typeof d === 'object' ? (d as Record<string, unknown>) : {})

/** A new room code and a host token. Input: { game, name?, deviceId }. */
export const createFriendChallenge = createServerFn({ method: 'POST' })
  .validator(inputOf)
  .handler(async ({ data }): Promise<Minted> => createChallenge(liveDeps(), { game: data.game, name: data.name, deviceId: data.deviceId }))

/** A guest token for a code from a link. Input: { code, name?, deviceId }. */
export const joinFriendChallenge = createServerFn({ method: 'POST' })
  .validator(inputOf)
  .handler(async ({ data }): Promise<Minted> => joinChallenge(liveDeps(), { code: data.code, name: data.name, deviceId: data.deviceId }))

/**
 * The end of a two-device friend game: the browser hands over the relay's signed result and its friend device id. The server verifies,
 * writes the result row once (result only: game, the two players, winner, date), and returns the head-to-head card. Input: { proof, deviceId }.
 */
export const recordFriendGame = createServerFn({ method: 'POST' })
  .validator(inputOf)
  .handler(async ({ data }): Promise<RecordResult> => {
    const { db } = await getServerDb()
    return recordFriendResult(db, friendDeps(), { proof: data.proof, deviceId: data.deviceId })
  })

/** The friends list: everyone you have played over a link, with your record against each. Input: { deviceId }. */
export const listFriends = createServerFn({ method: 'POST' })
  .validator(inputOf)
  .handler(async ({ data }): Promise<{ ok: true; friends: FriendRow[] } | { ok: false; error: string }> => {
    const { db } = await getServerDb()
    return friendsForViewer(db, friendDeps(), { deviceId: data.deviceId })
  })
