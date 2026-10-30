import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { decodeRecord } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { guestLabel } from '../lib/display-name'

type Db = PgDatabase<any, typeof schema>

export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']
const isLevel = (v: string): v is Level => (LEVELS as readonly string[]).includes(v)
const isGame = (g: string): g is GameId => Object.prototype.hasOwnProperty.call(PRODUCT.games, g)
export const DAY_MS = 86_400_000
/** The board and the opponents' records look back this far. */
export const WINDOW_DAYS = 30

export interface FinishedResult {
  id: string
  game: GameId
  level: Level
  outcome: 'human' | 'ai' | 'draw'
  finishedAt: Date
  /** Stable key of the player: `u:<user id>` or `g:<guest id>`. Never sent to the browser. */
  key: string
  /** The human's own moves in the record, the tie-break margin for turn games (fewer is better). Null when it is not a turn game. */
  humanMoves: number | null
  /** Score the human finished with, for the realtime games. */
  humanScore: number | null
  call: Level | null
}

/**
 * Valid finished matches since a date, read from the match store the same way stats.ts reads them: the record
 * must have replayed, a guest's match still waiting for its agent check is left out, and the human's seat comes from the record.
 */
export async function finishedResults(db: Db, opts: { game?: GameId; since: Date }): Promise<FinishedResult[]> {
  const rows = await db
    .select({
      id: schema.match.id,
      game: schema.match.game,
      level: schema.match.level,
      userId: schema.match.userId,
      guestId: schema.match.guestId,
      result: schema.match.result,
      record: schema.match.record,
      finishedAt: schema.match.finishedAt,
      call: schema.match.call,
    })
    .from(schema.match)
    .where(
      and(
        eq(schema.match.status, 'finished'),
        eq(schema.match.recordValid, true),
        gte(schema.match.finishedAt, opts.since),
        inArray(schema.match.level, [...LEVELS]),
        sql`${schema.match.filterFlags}->>'deferredCheckAt' is null`,
        ...(opts.game ? [eq(schema.match.game, opts.game)] : []),
      ),
    )
  const out: FinishedResult[] = []
  for (const r of rows) {
    if (!r.record || !r.result || !r.finishedAt || !isGame(r.game) || !isLevel(r.level)) continue
    let seat: 0 | 1
    let moves = 0
    try {
      const rec = decodeRecord(r.record)
      seat = rec.humanSeat
      moves = rec.actions.filter((a) => a[1] === seat).length
    } catch {
      continue
    }
    const key = r.userId ? `u:${r.userId}` : r.guestId ? `g:${r.guestId}` : null
    if (!key) continue
    const kind = PRODUCT.games[r.game].kind
    out.push({
      id: r.id,
      game: r.game,
      level: r.level,
      outcome: r.result.winner === null ? 'draw' : r.result.winner === seat ? 'human' : 'ai',
      finishedAt: r.finishedAt,
      key,
      humanMoves: kind === 'turn' || r.game === 'word' ? moves : null,
      humanScore: kind === 'realtime' ? (r.result.score?.[seat] ?? null) : null,
      call: r.call && isLevel(r.call) ? r.call : null,
    })
  }
  return out
}

export interface NameLookup {
  /** Public label for a player key, or null when the player hid themselves from the board. */
  label(key: string): string | null
}

const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? ''

/** Names for a set of player keys: the typed name, else the first name of a signed-in account, else "guest" and 4 characters. Opted-out players map to null. */
export async function loadNames(db: Db, keys: string[]): Promise<NameLookup> {
  const userIds = keys.filter((k) => k.startsWith('u:')).map((k) => k.slice(2))
  const guestIds = keys.filter((k) => k.startsWith('g:')).map((k) => k.slice(2))
  const map = new Map<string, string | null>()
  if (userIds.length) {
    const rows = await db
      .select({ id: schema.user.id, name: schema.user.name, display: schema.profile.displayName, show: schema.profile.showOnLeaderboard })
      .from(schema.user)
      .leftJoin(schema.profile, eq(schema.profile.userId, schema.user.id))
      .where(inArray(schema.user.id, userIds))
    for (const r of rows) map.set(`u:${r.id}`, r.show === false ? null : r.display?.trim() || firstName(r.name) || 'Player')
  }
  if (guestIds.length) {
    const rows = await db
      .select({ id: schema.guest.id, display: schema.guest.displayName, show: schema.guest.showOnLeaderboard })
      .from(schema.guest)
      .where(inArray(schema.guest.id, guestIds))
    for (const r of rows) map.set(`g:${r.id}`, r.show === false ? null : r.display?.trim() || guestLabel(r.id))
  }
  return {
    label(key) {
      if (map.has(key)) return map.get(key) ?? null
      return key.startsWith('g:') ? guestLabel(key.slice(2)) : 'Player'
    },
  }
}

/** The caller's own player keys: a signed-in player is their account and the guest id this browser still carries. */
export function keysOf(who: { userId?: string; guestId?: string }): string[] {
  return [...(who.userId ? [`u:${who.userId}`] : []), ...(who.guestId ? [`g:${who.guestId}`] : [])]
}

export const ownRows = (who: { userId?: string; guestId?: string }) =>
  or(
    ...(who.userId ? [eq(schema.match.userId, who.userId)] : []),
    ...(who.guestId ? [and(eq(schema.match.guestId, who.guestId), isNull(schema.match.userId))] : []),
  )
