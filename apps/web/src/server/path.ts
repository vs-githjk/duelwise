import type { PgDatabase } from 'drizzle-orm/pg-core'
import { competitive } from './competitive'
import { and, eq, inArray } from 'drizzle-orm'
import type { GameId, Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { LEVELS, ownRows } from './results'
import { recordLen, seatCols, seatsFor } from './record-seats'

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
    .select({ id: schema.match.id, level: schema.match.level, result: schema.match.result, finishedAt: schema.match.finishedAt, len: recordLen, ...seatCols })
    .from(schema.match)
    .where(and(eq(schema.match.game, game), eq(schema.match.status, 'finished'), eq(schema.match.recordValid, true), inArray(schema.match.level, [...LEVELS]), competitive, own))
  const won = rows.filter((r) => r.result && r.result.winner !== null)
  const seats = await seatsFor(db, won)
  for (const r of won) {
    if (cleared[r.level as Level]) continue
    if (seats.get(r.id)?.seat === r.result!.winner) cleared[r.level as Level] = true
  }
  return cleared
}
