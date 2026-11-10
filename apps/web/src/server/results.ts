import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { competitive } from './competitive'
import { notTestMatch } from './public-traffic'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { guestLabel } from '../lib/display-name'
import { recordLen, seatsFor, winnerCol } from './record-seats'

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
const finishedWhere = (opts: { game?: GameId; since: Date }) =>
  and(
    eq(schema.match.status, 'finished'),
    eq(schema.match.recordValid, true),
    isNotNull(schema.match.result),
    gte(schema.match.finishedAt, opts.since),
    inArray(schema.match.level, [...LEVELS]),
    sql`${schema.match.filterFlags}->>'deferredCheckAt' is null`,
    competitive,
    notTestMatch(),
    ...(opts.game ? [eq(schema.match.game, opts.game)] : []),
  )

/** Only who won at which level: the opponents' records need no player, score or call, so the rows stay a few bytes each. */
export async function finishedOutcomes(db: Db, opts: { game?: GameId; since: Date }): Promise<Array<{ level: Level; outcome: 'human' | 'ai' | 'draw' }>> {
  const rows = await db
    .select({ id: schema.match.id, level: schema.match.level, winner: winnerCol, finishedAt: schema.match.finishedAt, len: recordLen })
    .from(schema.match)
    .where(finishedWhere(opts))
  const seats = await seatsFor(db, rows)
  const out: Array<{ level: Level; outcome: 'human' | 'ai' | 'draw' }> = []
  for (const r of rows) {
    const info = seats.get(r.id)
    if (!info || !r.finishedAt || !isLevel(r.level)) continue
    out.push({ level: r.level, outcome: r.winner === null ? 'draw' : r.winner === info.seat ? 'human' : 'ai' })
  }
  return out
}

export async function finishedResults(db: Db, opts: { game?: GameId; since: Date }): Promise<FinishedResult[]> {
  const rows = await db
    .select({
      id: schema.match.id,
      game: schema.match.game,
      level: schema.match.level,
      userId: schema.match.userId,
      guestId: schema.match.guestId,
      result: schema.match.result,
      len: recordLen,
      finishedAt: schema.match.finishedAt,
      call: schema.match.call,
    })
    .from(schema.match)
    .where(finishedWhere(opts))
  const seats = await seatsFor(db, rows)
  const out: FinishedResult[] = []
  for (const r of rows) {
    if (!r.result || !r.finishedAt || !isGame(r.game) || !isLevel(r.level)) continue
    const info = seats.get(r.id)
    if (!info) continue
    const { seat, moves } = info
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
