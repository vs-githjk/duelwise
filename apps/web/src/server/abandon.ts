import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { Result } from '@duelwise/core/src/types'
import * as schema from '../db/schema'
import { applyRatingIfRanked } from './ratings'
import { saveRatingChange } from './report-store'
import { recordEvent } from './telemetry'

type Db = PgDatabase<any, typeof schema>

const MIN = 60 * 1000

/** The longest a counted match of each game can sensibly take, from start to finish. */
export const MAX_MATCH_MS: Record<GameId, number> = {
  chess: 90 * MIN,
  four: 30 * MIN,
  holdem: 60 * MIN,
  word: 30 * MIN,
  fighter: 20 * MIN,
  arena: 30 * MIN,
}

/** Extra time after the maximum before a silent match counts as abandoned (slow connections, a paused tab). */
export const ABANDON_GRACE_MS = 15 * MIN

/** The result a rated human takes when they walk away: the agent (seat 1) wins. Only used to score the rating. */
const LOSS: Result = { winner: 1, score: [0, 1], reason: 'abandoned' }

export interface AbandonOptions {
  /** The measured site Elo of an agent level, or null while it is a preview. */
  siteElo?: (game: GameId, level: Level, agentVersion: string) => number | null
}

type Abandoned = { id: string; userId: string | null; guestId: string | null; level: string; agentVersion: string; startedAt: Date }

/** Records the event and charges the loss for matches that were just flipped to 'abandoned'. */
export async function settleAbandoned(db: Db, game: GameId, rows: Abandoned[], now: Date, opts: AbandonOptions): Promise<void> {
  for (const r of rows) {
    await recordEvent(db, {
      kind: 'match_abandoned',
      matchId: r.id,
      game,
      level: r.level,
      who: { userId: r.userId, guestId: r.guestId },
      durationMs: Math.max(0, now.getTime() - r.startedAt.getTime()),
    })
    if (!r.userId) continue
    // Per-row catch: the rows are already marked abandoned, so one failed rating must not strand the rest.
    try {
      const change = await applyRatingIfRanked(db, {
        userId: r.userId,
        game,
        level: r.level as Level,
        humanSeat: 0,
        result: LOSS,
        siteElo: opts.siteElo?.(game, r.level as Level, r.agentVersion) ?? null,
      })
      if (change) await saveRatingChange(db, r.id, change)
    } catch (e) {
      console.error('abandon rating failed', r.userId, game, e instanceof Error ? e.message : e)
    }
  }
}

export const ABANDONED_ROW = { id: schema.match.id, userId: schema.match.userId, guestId: schema.match.guestId, level: schema.match.level, agentVersion: schema.match.agentVersion, startedAt: schema.match.startedAt }

/**
 * Settles every started match that outlived its game's maximum duration plus the grace period: the
 * row becomes 'abandoned' (and is kept out of training), and a signed-in player is charged a loss
 * exactly as if they had lost the match. The status flip is a compare-and-set on 'started', so a
 * match is scored once however many sweeps or late uploads race. Returns how many were abandoned.
 */
export async function abandonStale(db: Db, now: Date = new Date(), opts: AbandonOptions = {}): Promise<number> {
  let total = 0
  for (const game of Object.keys(PRODUCT.games) as GameId[]) {
    const cutoff = new Date(now.getTime() - MAX_MATCH_MS[game] - ABANDON_GRACE_MS)
    const rows = await db
      .update(schema.match)
      .set({ status: 'abandoned', trainingAllowed: false, invalidReason: 'abandoned', finishedAt: now, filterFlags: { abandoned: true } })
      .where(and(eq(schema.match.game, game), eq(schema.match.status, 'started'), lt(schema.match.startedAt, cutoff)))
      .returning(ABANDONED_ROW)
    await settleAbandoned(db, game, rows, now, opts)
    total += rows.length
  }
  return total
}

/** Most counted matches one player may have open at once (M2: it bounds what a script can write before the abandon rule runs). */
export const MAX_OPEN_MATCHES = 3

/**
 * Keeps a caller's open ('started') matches below the cap before a new one starts: the oldest beyond
 * `MAX_OPEN_MATCHES - 1` are settled as abandoned, exactly like the stale sweep (a signed-in player takes the loss).
 * Returns how many were swept.
 */
export async function sweepOpenOverCap(db: Db, who: { userId?: string | undefined; guestId?: string | undefined }, now: Date = new Date(), opts: AbandonOptions = {}): Promise<number> {
  const mine = who.userId ? eq(schema.match.userId, who.userId) : who.guestId ? and(eq(schema.match.guestId, who.guestId), isNull(schema.match.userId)) : undefined
  if (!mine) return 0
  const keep = MAX_OPEN_MATCHES - 1
  const open = await db
    .select({ id: schema.match.id })
    .from(schema.match)
    .where(and(mine, eq(schema.match.status, 'started')))
    .orderBy(desc(schema.match.startedAt), desc(schema.match.id))
    .offset(keep)
  if (open.length === 0) return 0
  const rows = await db
    .update(schema.match)
    .set({ status: 'abandoned', trainingAllowed: false, invalidReason: 'abandoned', finishedAt: now, filterFlags: { abandoned: true, overCap: true } })
    .where(and(inArray(schema.match.id, open.map((o) => o.id)), eq(schema.match.status, 'started')))
    .returning({ ...ABANDONED_ROW, game: schema.match.game })
  for (const r of rows) await settleAbandoned(db, r.game as GameId, [r], now, opts)
  return rows.length
}
