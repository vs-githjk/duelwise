// Filters for the learn-from-humans EXPORT (apps/web/scripts/export-human.ts). Four in a Row keeps its registered filter;
// chess and Hold'em get theirs here and are deliberately NOT in GAME_FILTERS (index.ts): that table means "this game has a
// retrain adapter", and neither of those has one that promotes a model yet.
import type { GameId } from '../product'
import { replayHands } from '../games/holdem/profile'
import { PASS, commonFilter, duplicateFilter, median, reject, type FilterContext, type FilterResult, type FilterRow } from './common'
import { fourFilter } from './four'

/** The human must have chosen at least this many chess moves. */
export const CHESS_MIN_HUMAN_MOVES = 8
/** Hold'em: a match with fewer hands than this teaches nothing about a player. */
export const HOLDEM_MIN_HANDS = 3
/** Median input time below this is a script, not a hand on a mouse (same floor as Four in a Row). */
export const MIN_MEDIAN_INPUT_MS = 150

function timingProblem(times: readonly number[] | undefined, minCount: number): string | null {
  if (!times || times.length < minCount) return null // timing is optional outside Four in a Row
  const med = median(times)
  return med < MIN_MEDIAN_INPUT_MS ? `median input time ${Math.round(med)} ms` : null
}

export function chessFilter(row: FilterRow): FilterResult {
  const r = row.record!
  const mine = r.actions.filter((a) => a[1] === r.humanSeat).length
  if (mine < CHESS_MIN_HUMAN_MOVES) return reject('too_short', `${mine} human moves`)
  const t = timingProblem(r.humanInputTimesMs, CHESS_MIN_HUMAN_MOVES)
  return t ? reject('inhuman_timing', t) : PASS
}

export function holdemFilter(row: FilterRow): FilterResult {
  const r = row.record!
  const hands = replayHands({ seed: r.seed, actions: r.actions, options: r.options, humanSeat: r.humanSeat })
  const played = hands.filter((h) => h.events.some((e) => e.seat === r.humanSeat))
  if (played.length < HOLDEM_MIN_HANDS) return reject('too_short', `${played.length} hands with a human decision`)
  // Folding every hand is a way to farm matches, not to play.
  const foldedAll = played.every((h) => h.events.some((e) => e.seat === r.humanSeat && e.kind === 'fold'))
  if (foldedAll) return reject('inhuman_timing', 'folded every hand')
  const t = timingProblem(r.humanInputTimesMs, 6)
  return t ? reject('inhuman_timing', t) : PASS
}

const OWN: Partial<Record<GameId, (row: FilterRow) => FilterResult>> = { four: fourFilter, chess: chessFilter, holdem: holdemFilter }

export const hasHumanFilter = (game: GameId): boolean => game in OWN

/** The common rules, the game's own rules, then duplicate detection. The first rejection wins. */
export function humanFilterMatch(row: FilterRow, ctx: FilterContext): FilterResult {
  const own = OWN[row.game]
  if (!own) throw new Error(`no human-data filters for ${row.game}`)
  const common = commonFilter(row)
  if (!common.ok) return common
  const g = own(row)
  if (!g.ok) return g
  return duplicateFilter(row, ctx)
}
