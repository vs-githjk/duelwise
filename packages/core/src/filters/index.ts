import type { GameId } from '../product'
import { commonFilter, duplicateFilter, newFilterContext, REJECT_REASONS, type FilterContext, type FilterResult, type FilterRow, type RejectReason } from './common'
import { fourFilter } from './four'

export * from './common'
export { fourFilter, fourMoves, fourStartPositions } from './four'
export { chessFilter, holdemFilter, hasHumanFilter, humanFilterMatch, CHESS_MIN_HUMAN_MOVES, HOLDEM_MIN_HANDS, MIN_MEDIAN_INPUT_MS } from './human'

/** Game-specific rules, run after the common ones. A game without an entry has no retrain adapter yet. */
const GAME_FILTERS: Partial<Record<GameId, (row: FilterRow) => FilterResult>> = {
  four: fourFilter,
}

export class NoFilterError extends Error {
  constructor(game: GameId) {
    super(`no training filters for ${game} yet: its retrain adapter has not been built`)
    this.name = 'NoFilterError'
  }
}

export const hasFilter = (game: GameId): boolean => game in GAME_FILTERS

/** Runs the common rules, the game's rules, then duplicate detection. The first rejection wins. */
export function filterMatch(row: FilterRow, ctx: FilterContext = newFilterContext()): FilterResult {
  const game = GAME_FILTERS[row.game]
  if (!game) throw new NoFilterError(row.game)
  const common = commonFilter(row)
  if (!common.ok) return common
  const own = game(row)
  if (!own.ok) return own
  return duplicateFilter(row, ctx)
}

export interface FilterReport {
  kept: FilterRow[]
  rejected: Array<{ id: string; reason: RejectReason; detail: string }>
  /** Count per reason, every reason present. */
  counts: Record<RejectReason, number>
}

/** Filters rows in the order given (oldest first, so the earliest copy of a duplicate is the one kept). */
export function filterMatches(rows: readonly FilterRow[]): FilterReport {
  const ctx = newFilterContext()
  const kept: FilterRow[] = []
  const rejected: FilterReport['rejected'] = []
  const counts = Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as Record<RejectReason, number>
  for (const row of rows) {
    const res = filterMatch(row, ctx)
    if (res.ok) kept.push(row)
    else {
      rejected.push({ id: row.id, reason: res.reason, detail: res.detail })
      counts[res.reason]++
    }
  }
  return { kept, rejected, counts }
}
