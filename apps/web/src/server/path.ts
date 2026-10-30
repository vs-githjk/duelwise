import type { PgDatabase } from 'drizzle-orm/pg-core'
import { and, eq, inArray } from 'drizzle-orm'
import { decodeRecord } from '@duelwise/core/src/match-record'
import type { GameId, Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { LEVELS, ownRows } from './results'

type Db = PgDatabase<any, typeof schema>

export type PathMap = Record<Level, boolean>

/**
 * The player's adventure path for one game: a stop is cleared once they have a finished win at that level (Practice levels
 * count here, they are only unranked on the board). The source is the match store; the browser mirrors it for an instant first paint.
 */
export async function getPath(db: Db, who: { userId?: string; guestId?: string }, game: GameId): Promise<PathMap> {
  const cleared = Object.fromEntries(LEVELS.map((l) => [l, false])) as PathMap
  const own = ownRows(who)
  if (!own) return cleared
  const rows = await db
    .select({ level: schema.match.level, result: schema.match.result, record: schema.match.record })
    .from(schema.match)
    .where(and(eq(schema.match.game, game), eq(schema.match.status, 'finished'), eq(schema.match.recordValid, true), inArray(schema.match.level, [...LEVELS]), own))
  for (const r of rows) {
    if (!r.record || !r.result || r.result.winner === null || cleared[r.level as Level]) continue
    try {
      if (decodeRecord(r.record).humanSeat === r.result.winner) cleared[r.level as Level] = true
    } catch {}
  }
  return cleared
}
