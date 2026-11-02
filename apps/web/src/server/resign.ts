import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { GameId, Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import type { Caller, FinishOptions, HandlerResponse } from './match-handlers'
import { applyRatingIfRanked } from './ratings'
import { saveRatingChange } from './report-store'
import { recordEvent } from './telemetry'
import { loggedOutcome } from '@duelwise/core/src/sealed-log'
import { isPractice, isUnplayed, keptSealedFlags, LOGGED_WIN_FLAG, PRACTICE_FLAG, sealedLogStill, UNPLAYED_FLAG } from './competitive'

type Db = PgDatabase<any, typeof schema>

export interface ResignBody {
  resigned: true
  /** Set when a sealed match ended before its first shot: nothing was played, so nothing was charged. */
  unplayed?: boolean
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

  // A shot may land between the read and the write, and whether the match was played decides the rating. So the write holds only if the
  // stored log is still the one the decision read; otherwise it reads again. A sealed log grows by one shot per turn and each read sees the latest.
  let row: typeof schema.match.$inferSelect
  let unplayed: boolean
  let wonBefore: boolean
  for (;;) {
    const read = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)).limit(1))[0]
    if (!read) return err(404, 'unknown match')
    const mine = who.userId ? read.userId === who.userId : read.guestId === who.guestId && read.userId === null
    if (!mine) return err(403, 'not your match')
    if (read.status !== 'started') return err(409, `match is already ${read.status}`)

    // A sealed match whose setup never reached the server was never played and revealed nothing: ending it costs no rating.
    const notPlayed = isUnplayed(read.game, read.filterFlags)
    // The server's own log may already say the player won (the winning shot stored, the reply lost): giving up then costs nothing.
    const won = loggedOutcome(read.game as GameId, read.seed, read.filterFlags)?.result?.winner === 0
    const updated = await db
      .update(schema.match)
      .set({ status: 'resigned', trainingAllowed: false, invalidReason: 'resigned', filterFlags: { resigned: true, resignTick, ...(isPractice(read.filterFlags) ? { [PRACTICE_FLAG]: true } : {}), ...(notPlayed ? { [UNPLAYED_FLAG]: true } : {}), ...keptSealedFlags(read.game, read.filterFlags), ...(won ? { [LOGGED_WIN_FLAG]: true } : {}) }, finishedAt: new Date() })
      .where(and(eq(schema.match.id, read.id), eq(schema.match.status, 'started'), sealedLogStill(read.filterFlags)))
      .returning({ id: schema.match.id })
    if (updated.length > 0) {
      row = read
      unplayed = notPlayed
      wonBefore = won
      break
    }
    // Nothing was written: the row was settled (the next read says so) or the log grew (the next read decides again).
  }

  await recordEvent(db, {
    kind: 'match_resigned',
    matchId: row.id,
    game: row.game,
    level: row.level,
    who: { userId: row.userId, guestId: row.guestId },
    durationMs: Math.max(0, Date.now() - row.startedAt.getTime()),
  })

  // A practice match moves no rating, so a resignation costs nothing; neither does one after the log says the player won.
  if (!row.userId || isPractice(row.filterFlags) || unplayed || wonBefore) return { status: 200, body: { resigned: true, ...(unplayed ? { unplayed: true } : {}) } }
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
