import { and, eq, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { expected, kFor } from '@duelwise/core/src/elo'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import * as schema from '../db/schema'

type Db = PgDatabase<any, typeof schema>

/**
 * The opponent rating a registry's measured site Elo gives a level. Realtime games get null: their levels are
 * gated against scripted bots, so the chained number rests on an Easy players never face (R30) and ratings stay provisional.
 */
export function ratedSiteElo(game: GameId, measured: unknown): number | null {
  if (PRODUCT.games[game].kind === 'realtime') return null
  return typeof measured === 'number' && Number.isFinite(measured) ? measured : null
}

/** Rating of a player with no rated matches yet. */
export const START_ELO = 1000

/**
 * Stand-in opponent ratings for a level the registry has not measured yet. A rating earned against
 * one is labelled provisional in the UI and replaced by the registry's site Elo once it is measured.
 */
export const PROVISIONAL_LEVEL_ELO: Record<Level, number> = { easy: 1000, medium: 1200, hard: 1400, champion: 1600 }

export interface RatingChange {
  before: number
  after: number
  /** True when the opponent's rating was the stand-in above, not a measured site Elo. */
  provisional: boolean
}

export interface RatingInput {
  userId: string
  game: GameId
  level: Level
  humanSeat: Seat
  result: Result
  /** The level's measured site Elo from the registry, or null for a preview level. */
  siteElo: number | null
}

/** Applies one valid, finished match to a signed-in user's rating (k 40 for the first 10 games, then 24). */
export async function applyRating(db: Db, input: RatingInput): Promise<RatingChange> {
  const opp = input.siteElo ?? PROVISIONAL_LEVEL_ELO[input.level]
  const score: 0 | 0.5 | 1 = input.result.winner === null ? 0.5 : input.result.winner === input.humanSeat ? 1 : 0
  // No interactive transaction: the production driver (neon-http) does not support them. The write is a
  // compare-and-set on (elo, games), retried when a concurrent match for the same user moved the row.
  const key = and(eq(schema.rating.userId, input.userId), eq(schema.rating.game, input.game))
  await db.insert(schema.rating).values({ userId: input.userId, game: input.game, elo: START_ELO, games: 0 }).onConflictDoNothing()
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = (await db.select().from(schema.rating).where(key).limit(1))[0]!
    const after = Math.round(row.elo + kFor(row.games) * (score - expected(row.elo, opp)))
    const done = await db
      .update(schema.rating)
      .set({ elo: after, games: sql`${schema.rating.games} + 1` })
      .where(and(key, eq(schema.rating.elo, row.elo), eq(schema.rating.games, row.games)))
      .returning({ games: schema.rating.games })
    if (done.length > 0) return { before: row.elo, after, provisional: input.siteElo === null }
  }
  throw new Error('rating update kept conflicting')
}

/**
 * applyRating for a game whose matches may move a rating. Real-time games (the fighter and the arena shooter) return null:
 * their agent's inputs are not re-run on the server yet, so a forged record could raise a rating. Their matches stay
 * out of ratings and the leaderboard until that check exists.
 */
export async function applyRatingIfRanked(db: Db, input: RatingInput): Promise<RatingChange | null> {
  if (PRODUCT.games[input.game].kind === 'realtime') return null
  return applyRating(db, input)
}
