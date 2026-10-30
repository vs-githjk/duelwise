import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type * as schema from '../db/schema'
import { withSuffixes } from '../lib/display-name'
import { AGGREGATE_TTL_MS, cachedFor } from './ttl-cache'
import { DAY_MS, LEVELS, WINDOW_DAYS, finishedResults, keysOf, loadNames, type FinishedResult } from './results'

type Db = PgDatabase<any, typeof schema>

export const TOP_N = 10

export interface BoardRow {
  rank: number
  name: string
  wins: number
  me?: boolean
}

export interface BoardColumn {
  level: Level
  /** True while the level has no measured strength: its wins count on a player's own path, never on the board. */
  practice: boolean
  /** Distinct players with at least one finished match at this level in the window. */
  players: number
  rows: BoardRow[]
  /** Ranked players below the top rows. */
  more: number
  /** The viewer's own place: rank null while hidden or unranked. */
  me: { rank: number | null; wins: number; name: string; hidden: boolean } | null
}

export interface LevelBoard {
  game: GameId
  windowDays: number
  columns: BoardColumn[]
}

interface Tally {
  wins: number
  bestMargin: number
  firstWin: number
}

/**
 * Wins per player at each level over the window, for everybody, guests included (name only). Ties are broken by the game's margin
 * (fewest of the human's own moves in a win for the turn games, the larger score for the real-time games) and then by who got there first.
 * A Practice level is never ranked: only its player count shows. A player who hid themselves is left out of the ranks.
 */
export async function getLevelBoard(
  db: Db,
  game: GameId,
  who: { userId?: string; guestId?: string },
  practiceLevels: ReadonlySet<Level>,
  now: Date = new Date(),
  results?: FinishedResult[],
): Promise<LevelBoard> {
  const rows = results ?? (await finishedResults(db, { game, since: new Date(now.getTime() - WINDOW_DAYS * DAY_MS) }))
  const names = await loadNames(db, [...new Set([...rows.map((r) => r.key), ...keysOf(who)])])
  const mine = new Set(keysOf(who))
  const columns: BoardColumn[] = LEVELS.map((level) => {
    const here = rows.filter((r) => r.level === level)
    const players = new Set(here.map((r) => r.key)).size
    const practice = practiceLevels.has(level)
    const tallies = new Map<string, Tally>()
    for (const r of here) {
      if (r.outcome !== 'human') continue
      const margin = r.humanMoves ?? (r.humanScore !== null ? -r.humanScore : Number.POSITIVE_INFINITY)
      const t = tallies.get(r.key) ?? { wins: 0, bestMargin: Number.POSITIVE_INFINITY, firstWin: Number.POSITIVE_INFINITY }
      t.wins++
      t.bestMargin = Math.min(t.bestMargin, margin)
      t.firstWin = Math.min(t.firstWin, r.finishedAt.getTime())
      tallies.set(r.key, t)
    }
    const myKey = [...mine].find((k) => tallies.has(k)) ?? null
    const myWins = [...mine].reduce((n, k) => n + (tallies.get(k)?.wins ?? 0), 0)
    const myName = [...mine].map((k) => names.label(k)).find((n) => n !== null) ?? 'You'
    if (practice) {
      return { level, practice, players, rows: [], more: 0, me: mine.size ? { rank: null, wins: myWins, name: myName, hidden: false } : null }
    }
    const ranked = [...tallies.entries()]
      .filter(([k]) => names.label(k) !== null)
      .sort(([, a], [, b]) => b.wins - a.wins || a.bestMargin - b.bestMargin || a.firstWin - b.firstWin)
    const labels = withSuffixes(ranked.map(([k]) => names.label(k)!))
    const all: BoardRow[] = ranked.map(([k, t], i) => ({ rank: i + 1, name: labels[i]!, wins: t.wins, ...(mine.has(k) ? { me: true } : {}) }))
    const meRow = all.find((r) => r.me)
    const hidden = Boolean(myKey) && !meRow
    return {
      level,
      practice,
      players,
      rows: all.slice(0, TOP_N),
      more: Math.max(0, all.length - TOP_N),
      me: mine.size ? { rank: meRow?.rank ?? null, wins: myWins, name: meRow?.name ?? myName, hidden } : null,
    }
  })
  return { game, windowDays: WINDOW_DAYS, columns }
}

export interface OpponentRecord {
  level: Level
  /** Matches the opponent won against people in the window. */
  wins: number
  /** Matches people won against it. */
  losses: number
}

/** The fight card's records: each persona's wins and losses against people over the window, across all six games. Draws are not counted. */
export async function getOpponentRecords(db: Db, now: Date = new Date(), results?: FinishedResult[]): Promise<OpponentRecord[]> {
  const rows = results ?? (await finishedResults(db, { since: new Date(now.getTime() - WINDOW_DAYS * DAY_MS) }))
  return LEVELS.map((level) => {
    const here = rows.filter((r) => r.level === level)
    return { level, wins: here.filter((r) => r.outcome === 'ai').length, losses: here.filter((r) => r.outcome === 'human').length }
  })
}

/** getOpponentRecords behind the short per-database cache: it decodes every finished match of the window, so a landing page load must not pay that each time. Records may lag by up to the TTL. */
export function getOpponentRecordsCached(db: Db, nowMs: number = Date.now(), ttlMs: number = AGGREGATE_TTL_MS): Promise<OpponentRecord[]> {
  return cachedFor(db, 'opponent-records', nowMs, ttlMs, () => getOpponentRecords(db, new Date(nowMs)))
}

/** Score the game's Practice levels from a registry summary: levels without a measured block. */
export function practiceLevelsOf(levels: Array<{ level: Level; state: 'measured' | 'in-training' }>): Set<Level> {
  return new Set(levels.filter((l) => l.state !== 'measured').map((l) => l.level))
}

export const ALL_GAMES = Object.keys(PRODUCT.games) as GameId[]
