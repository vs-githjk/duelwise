import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { GameId, Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import type { Caller, FinishOptions, HandlerResponse } from './match-handlers'
import { applyRatingIfRanked } from './ratings'
import { saveRatingChange } from './report-store'
import { recordEvent } from './telemetry'
import { isPractice, PRACTICE_FLAG } from './competitive'

type Db = PgDatabase<any, typeof schema>

export interface ResignBody {
  resigned: true
  /** Set only for a signed-in player: the rating before and after the loss. */
  elo?: { before: number; after: number }
  provisional?: boolean
}

const err = (status: number, message: string): HandlerResponse<{ error: string }> => ({ status, body: { error: message } })

/**
 * A player gives up a counted match. The row becomes 'resigned' with the tick it happened at, the
 * match is kept out of training, and a signed-in player takes a loss exactly like losing the game.
 * No record is stored: a resigned match has no replayable end.
 */
export async function resignMatchHandler(
  db: Db,
  input: unknown,
  who: Caller,
  opts: FinishOptions = {},
): Promise<HandlerResponse<ResignBody | { error: string }>> {
  if (typeof input !== 'object' || input === null) return err(400, 'expected { matchId, tick }')
  const { matchId, tick } = input as { matchId?: unknown; tick?: unknown }
  if (typeof matchId !== 'string' || matchId.length === 0 || matchId.length > 80) return err(400, 'expected a match id')
  const resignTick = typeof tick === 'number' && Number.isFinite(tick) ? Math.min(Math.max(Math.trunc(tick), 0), 10_000_000) : 0
  if (!who.userId && !who.guestId) return err(401, 'no player')

  const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)).limit(1))[0]
  if (!row) return err(404, 'unknown match')
  const mine = who.userId ? row.userId === who.userId : row.guestId === who.guestId && row.userId === null
  if (!mine) return err(403, 'not your match')
  if (row.status !== 'started') return err(409, `match is already ${row.status}`)

  const updated = await db
    .update(schema.match)
    .set({ status: 'resigned', trainingAllowed: false, invalidReason: 'resigned', filterFlags: { resigned: true, resignTick, ...(isPractice(row.filterFlags) ? { [PRACTICE_FLAG]: true } : {}) }, finishedAt: new Date() })
    .where(and(eq(schema.match.id, row.id), eq(schema.match.status, 'started')))
    .returning({ id: schema.match.id })
  if (updated.length === 0) return err(409, 'match was settled by another request')

  await recordEvent(db, {
    kind: 'match_resigned',
    matchId: row.id,
    game: row.game,
    level: row.level,
    who: { userId: row.userId, guestId: row.guestId },
    durationMs: Math.max(0, Date.now() - row.startedAt.getTime()),
  })

  // A practice match moves no rating, so a resignation costs nothing.
  if (!row.userId || isPractice(row.filterFlags)) return { status: 200, body: { resigned: true } }
  const change = await applyRatingIfRanked(db, {
    userId: row.userId,
    game: row.game as GameId,
    level: row.level as Level,
    humanSeat: 0,
    result: { winner: 1, score: [0, 1], reason: 'resigned' },
    siteElo: opts.siteElo?.(row.game as GameId, row.level as Level, row.agentVersion) ?? null,
  })
  if (!change) return { status: 200, body: { resigned: true } }
  await saveRatingChange(db, row.id, change)
  return { status: 200, body: { resigned: true, elo: { before: change.before, after: change.after }, provisional: change.provisional } }
}
