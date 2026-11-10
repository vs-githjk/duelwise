import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { competitive, LOGGED_WIN_FLAG, PRACTICE_FLAG } from './competitive'
import { notTestMatch } from './public-traffic'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { decodeRecord } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import type { Tally } from './stats'
import { recordLen, seatCols, seatsFor, winnerCol, type SeatInfo } from './record-seats'
import { AGGREGATE_TTL_MS, cachedFor } from './ttl-cache'

type Db = PgDatabase<any, typeof schema>

const GAMES = Object.keys(PRODUCT.games) as GameId[]
const isGame = (g: string): g is GameId => Object.prototype.hasOwnProperty.call(PRODUCT.games, g)

/** Last 7 days of valid finished matches for one game, every level together, from the human's side. */
export interface GameWeek extends Tally {
  game: GameId
}

export interface ResultRow {
  id: string
  game: GameId
  level: Level
  outcome: 'human' | 'ai' | 'draw'
  finishedAt: string
}

export interface Board {
  /** Valid finished matches in the last 7 days. */
  matches: number
  humanWins: number
  perGame: GameWeek[]
  latest: ResultRow[]
}

/** Result of a stored match from the human's seat, read from the record like stats.ts does. Null when the record cannot be read. */
export function outcomeOf(record: Uint8Array | null, winner: number | null | undefined): 'human' | 'ai' | 'draw' | null {
  if (!record) return null
  let seat: 0 | 1
  try {
    seat = decodeRecord(record).humanSeat
  } catch {
    return null
  }
  if (winner === null || winner === undefined) return 'draw'
  return winner === seat ? 'human' : 'ai'
}

/** The same answer as outcomeOf, from a seat that was already read off the record. */
function outcomeFromSeat(info: SeatInfo | null | undefined, winner: number | null | undefined): 'human' | 'ai' | 'draw' | null {
  if (!info) return null
  if (winner === null || winner === undefined) return 'draw'
  return winner === info.seat ? 'human' : 'ai'
}

interface RawRow {
  id: string
  game: string
  level: string
  winner: number | null
  len: number | null
  finishedAt: Date | null
}

function toRows(rows: RawRow[], limit: number, seats: Map<string, SeatInfo | null>): ResultRow[] {
  const out: ResultRow[] = []
  for (const r of rows) {
    if (out.length >= limit) break
    if (!r.finishedAt || !isGame(r.game)) continue
    const outcome = outcomeFromSeat(seats.get(r.id), r.winner)
    if (!outcome) continue
    out.push({ id: r.id, game: r.game, level: r.level as Level, outcome, finishedAt: r.finishedAt.toISOString() })
  }
  return out
}

const cols = {
  id: schema.match.id,
  game: schema.match.game,
  level: schema.match.level,
  winner: winnerCol,
  len: recordLen,
  ...seatCols,
  finishedAt: schema.match.finishedAt,
}

const WEEK_MS = 7 * 86_400_000

/**
 * The public board: a 7-day tally per game and the newest finished matches, with no player identity. Two queries in all
 * (the week's rows, the newest rows), neither of which downloads a record the instance has already decoded.
 */
export async function getBoard(db: Db, now: Date = new Date(), latestLimit = 4): Promise<Board> {
  const valid = and(eq(schema.match.status, 'finished'), eq(schema.match.recordValid, true), isNotNull(schema.match.result), sql`${schema.match.filterFlags}->>'deferredCheckAt' is null`, competitive, notTestMatch())
  const week = await db
    .select(cols)
    .from(schema.match)
    .where(and(valid, gte(schema.match.finishedAt, new Date(now.getTime() - WEEK_MS))))
  const newest = await db
    .select(cols)
    .from(schema.match)
    .where(valid)
    .orderBy(desc(schema.match.finishedAt))
    .limit(latestLimit * 3)
  const seats = await seatsFor(db, [...week, ...newest])
  const tallies = new Map<GameId, Tally>()
  for (const m of week) {
    const info = seats.get(m.id)
    if (!info || !m.finishedAt || !isGame(m.game) || !(LEVEL_ORDER as readonly string[]).includes(m.level)) continue
    // A match a week old to the millisecond belongs to the week before, like the owner stats.
    if (now.getTime() - m.finishedAt.getTime() >= WEEK_MS) continue
    const t = tallies.get(m.game) ?? { games: 0, wins: 0 }
    t.games++
    if (m.winner === info.seat) t.wins++
    tallies.set(m.game, t)
  }
  const perGame: GameWeek[] = GAMES.map((game) => ({ game, ...(tallies.get(game) ?? { games: 0, wins: 0 }) }))
  return {
    matches: perGame.reduce((n, g) => n + g.games, 0),
    humanWins: perGame.reduce((n, g) => n + g.wins, 0),
    perGame,
    latest: toRows(newest as RawRow[], latestLimit, seats),
  }
}

/** getBoard behind the short per-database cache: it scans every match of every game, so a landing load must not pay that each time. The tally may lag by up to the TTL. */
export function getBoardCached(db: Db, nowMs: number = Date.now(), ttlMs: number = AGGREGATE_TTL_MS, latestLimit = 4): Promise<Board> {
  return cachedFor(db, `board:${latestLimit}`, nowMs, ttlMs, () => getBoard(db, new Date(nowMs), latestLimit))
}

const LEVEL_ORDER: readonly Level[] = ['easy', 'medium', 'hard', 'champion']
const DAY_MS = 86_400_000

/** What happened to one of the player's finished matches for training. Only what the database stores can be said. */
export type Learning = 'Eligible for training' | 'Stats only' | `Rejected: ${string}`

export interface MyMatch {
  id: string
  game: GameId
  level: Level
  /** Null for a rejected record: a tampered or unreplayable match never shows a result. */
  outcome: 'human' | 'ai' | 'draw' | null
  finishedAt: string
  learning: Learning
}

export interface MyGameStats {
  game: GameId
  won: number
  total: number
  /** Whole percent, 0 when nothing is played. */
  winRate: number
  /** Consecutive wins ending at the newest match. */
  streak: number
  /** Highest level the player has beaten, null when none. */
  best: Level | null
  beaten: Level[]
  /** Lowest level not beaten yet, null when all four are beaten. */
  next: Level | null
  lastOutcome: 'human' | 'ai' | 'draw' | null
}

export interface MyRecord {
  ratings: Array<{ game: GameId; elo: number; games: number }>
  recent: MyMatch[]
  perGame: MyGameStats[]
  /** finishedAt (ISO) of every valid match in the last 8 days, so the browser can bucket them by the viewer's local day. */
  activity: string[]
  /** Set when the totals below cover only the newest N matches (the player has more); null when they cover everything. */
  window: number | null
  /** The lowest unbeaten level in the game the player played most recently. */
  nextChallenge: { game: GameId; level: Level } | null
}

/** Newest matches the per-game totals are built from. Each one is decoded to read the human's seat, so this bounds the work. */
export const STATS_WINDOW = 200

function learningOf(
  r: { game: GameId; recordValid: boolean | null; invalidReason: string | null; trainingAllowed: boolean; filterFlags: Record<string, unknown> | null },
  learnsFromHumans: (game: GameId) => boolean,
): Learning {
  if (r.recordValid === false) return `Rejected: ${r.invalidReason ?? 'record did not replay'}`
  if (!learnsFromHumans(r.game)) return 'Stats only'
  // A practice match is unrated, not filtered: it is trained on when the player allowed it.
  const flagged = r.filterFlags && Object.entries(r.filterFlags).some(([k, v]) => v === true && k !== PRACTICE_FLAG && k !== LOGGED_WIN_FLAG)
  return r.trainingAllowed && !flagged ? 'Eligible for training' : 'Stats only'
}

/** A signed-in player's own ratings, recent matches with their learning status, per-game record and a 7-day activity strip. */
export async function getMyRecord(
  db: Db,
  userId: string,
  limit = 5,
  now: Date = new Date(),
  learnsFromHumans: (game: GameId) => boolean = () => true,
): Promise<MyRecord> {
  const ratings = await db.select().from(schema.rating).where(eq(schema.rating.userId, userId))
  const rows = await db
    .select({
      ...cols,
      status: schema.match.status,
      recordValid: schema.match.recordValid,
      invalidReason: schema.match.invalidReason,
      trainingAllowed: schema.match.trainingAllowed,
      filterFlags: schema.match.filterFlags,
    })
    .from(schema.match)
    .where(
      and(
        eq(schema.match.userId, userId),
        or(
          and(eq(schema.match.status, 'finished'), inArray(schema.match.recordValid, [true, false]), sql`${schema.match.filterFlags}->>'deferredCheckAt' is null`, competitive),
          // A resignation or abandonment costs rating like a loss, so it counts as one here (a sealed row settled as never played is dropped by competitive). These rows have no record.
          and(inArray(schema.match.status, ['resigned', 'abandoned']), competitive),
        ),
      ),
    )
    .orderBy(desc(schema.match.finishedAt))
    .limit(STATS_WINDOW)

  const seats = await seatsFor(db, rows.filter((r) => r.status === 'finished' && r.recordValid === true))
  const mine: MyMatch[] = []
  for (const r of rows as Array<RawRow & Parameters<typeof learningOf>[0] & { status: string }>) {
    if (!r.finishedAt || !isGame(r.game)) continue
    const rejected = r.recordValid === false
    const gaveUp = r.status === 'resigned' || r.status === 'abandoned'
    const outcome = gaveUp ? 'ai' : rejected ? null : outcomeFromSeat(seats.get(r.id), r.winner)
    if (!rejected && !outcome) continue
    mine.push({ id: r.id, game: r.game, level: r.level as Level, outcome, finishedAt: r.finishedAt.toISOString(), learning: learningOf({ ...r, game: r.game }, learnsFromHumans) })
  }

  const valid = mine.filter((m) => m.outcome !== null)
  const perGame: MyGameStats[] = []
  for (const game of GAMES) {
    const ms = valid.filter((m) => m.game === game)
    if (ms.length === 0) continue
    const beaten = LEVEL_ORDER.filter((l) => ms.some((m) => m.level === l && m.outcome === 'human'))
    let streak = 0
    for (const m of ms) {
      if (m.outcome !== 'human') break
      streak++
    }
    const won = ms.filter((m) => m.outcome === 'human').length
    perGame.push({
      game,
      won,
      total: ms.length,
      winRate: Math.round((won / ms.length) * 100),
      streak,
      best: beaten.length ? beaten[beaten.length - 1]! : null,
      beaten,
      next: LEVEL_ORDER.find((l) => !beaten.includes(l)) ?? null,
      lastOutcome: ms[0]!.outcome,
    })
  }

  const since = now.getTime() - 8 * DAY_MS
  const activity = valid.filter((m) => Date.parse(m.finishedAt) > since).map((m) => m.finishedAt)

  const latestGame = valid[0]?.game
  const latestStats = perGame.find((g) => g.game === latestGame)
  return {
    ratings: ratings.filter((x) => isGame(x.game) && PRODUCT.games[x.game as GameId].kind !== 'realtime').map((x) => ({ game: x.game as GameId, elo: x.elo, games: x.games })),
    recent: mine.slice(0, limit),
    perGame,
    activity,
    window: rows.length >= STATS_WINDOW ? STATS_WINDOW : null,
    nextChallenge: latestStats?.next ? { game: latestStats.game, level: latestStats.next } : null,
  }
}
