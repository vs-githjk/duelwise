import { and, desc, eq, gte, isNull, or } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { defaultTrainingAllowed, guestOptedOut } from './profile'
import type { Caller } from './match-handlers'

type Db = PgDatabase<any, typeof schema>

/** A player appears on a game's leaderboard after this many rated matches. */
export const MIN_GAMES = 5

export interface LeaderboardRow {
  rank: number
  /** First name only (a privacy default); the email never leaves the server. */
  name: string
  elo: number
  games: number
}

export async function getLeaderboard(db: Db, game: GameId, limit = 50): Promise<LeaderboardRow[]> {
  // Real-time games are unranked until their agent's inputs are re-run on the server (S1); ratings an earlier build wrote never show.
  if (!ranksPlayers(game)) return []
  const rows = await db
    .select({ name: schema.user.name, elo: schema.rating.elo, games: schema.rating.games })
    .from(schema.rating)
    .innerJoin(schema.user, eq(schema.user.id, schema.rating.userId))
    .leftJoin(schema.profile, eq(schema.profile.userId, schema.rating.userId))
    // A player with no profile row has never touched the switch, so they are shown; a row says otherwise only when they turned it off.
    .where(and(eq(schema.rating.game, game), gte(schema.rating.games, MIN_GAMES), or(isNull(schema.profile.userId), eq(schema.profile.showOnLeaderboard, true))))
    .orderBy(desc(schema.rating.elo), desc(schema.rating.games), schema.user.name)
    .limit(limit)
  return rows.map((r, i) => ({ rank: i + 1, name: r.name.trim().split(/\s+/)[0] || 'Player', elo: r.elo, games: r.games }))
}

/** False for the real-time games: their matches change no rating and they have no leaderboard yet. */
export function ranksPlayers(game: GameId): boolean {
  return PRODUCT.games[game].kind !== 'realtime'
}

/** The caller's own rating for a game, whether or not they are on the board yet. */
export async function getUserRating(db: Db, userId: string, game: GameId): Promise<{ elo: number; games: number } | null> {
  if (!ranksPlayers(game)) return null
  const r = (
    await db
      .select({ elo: schema.rating.elo, games: schema.rating.games })
      .from(schema.rating)
      .where(and(eq(schema.rating.userId, userId), eq(schema.rating.game, game)))
      .limit(1)
  )[0]
  return r ?? null
}

export interface LeaderboardView {
  rows: LeaderboardRow[]
  minGames: number
  /** The signed-in viewer's own standing, if they have rated matches in this game. */
  me: { elo: number; games: number } | null
  /** True for any signed-in viewer, even one with no rating row yet. */
  signedIn: boolean
  /** False for a game whose matches change no rating (real-time games), so the page says so instead of inviting people to play for a place. */
  ranked: boolean
}

/** Plain handler behind getLeaderboardView: settles stale matches first, so abandoned games count before the board is read. */
export async function leaderboardViewHandler(
  db: Db,
  game: GameId,
  userId: string | null,
  now: Date,
  sweep: (db: Db, now: Date) => Promise<void>,
): Promise<LeaderboardView> {
  await sweep(db, now)
  return {
    rows: await getLeaderboard(db, game),
    minGames: MIN_GAMES,
    signedIn: userId !== null,
    ranked: ranksPlayers(game),
    me: userId ? await getUserRating(db, userId, game) : null,
  }
}

/** Whether the player's first name may appear on the public leaderboard (default yes). */
export async function getShowOnLeaderboard(db: Db, userId: string): Promise<boolean> {
  const p = (await db.select({ show: schema.profile.showOnLeaderboard }).from(schema.profile).where(eq(schema.profile.userId, userId)).limit(1))[0]
  return p?.show ?? true
}

/** Stores the switch. A signed-in player only; the profile row is created on first use with the usual training default (an opt-out made as a guest carries over). */
export async function setShowOnLeaderboard(db: Db, who: Caller, show: boolean): Promise<void> {
  if (!who.userId) return
  await db
    .insert(schema.profile)
    .values({ userId: who.userId, trainingAllowed: (await guestOptedOut(db, who.guestId)) ? false : defaultTrainingAllowed(), showOnLeaderboard: show })
    .onConflictDoUpdate({ target: schema.profile.userId, set: { showOnLeaderboard: show } })
}
