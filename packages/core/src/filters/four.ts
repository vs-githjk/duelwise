import type { MatchRecordV1 } from '../match-record'
import { PASS, median, reject, type FilterResult, type FilterRow } from './common'

/** A Four in a Row game needs 7 plies at the very least; under 8 is a throwaway. */
export const FOUR_MIN_PLIES = 8
/** The human must have chosen at least this many moves. */
export const FOUR_MIN_HUMAN_MOVES = 3
/** Median think time of a person choosing a column, ms. A script or a pre-computed replay is faster. */
export const FOUR_MIN_MEDIAN_THINK_MS = 150
/** Think times that all sit within this many ms of each other come from a timer, not a person. */
export const FOUR_MIN_SPREAD_MS = 20

/** The columns played, in order. Turn-based records key actions by step index. */
export function fourMoves(r: MatchRecordV1): number[] {
  return [...r.actions].sort((a, b) => a[0] - b[0]).map((a) => a[2])
}

/** The rules specific to Four in a Row: length and the human's timing. */
export function fourFilter(row: FilterRow): FilterResult {
  const r = row.record!
  const plies = r.actions.length
  const human = r.actions.filter((a) => a[1] === r.humanSeat).length
  if (plies < FOUR_MIN_PLIES || human < FOUR_MIN_HUMAN_MOVES) return reject('too_short', `${plies} plies, ${human} human moves`)
  const times = r.humanInputTimesMs
  if (!times || times.length !== human) {
    return reject('inhuman_timing', `${times?.length ?? 0} think times for ${human} human moves`)
  }
  const med = median(times)
  if (med < FOUR_MIN_MEDIAN_THINK_MS) return reject('inhuman_timing', `median think time ${Math.round(med)} ms`)
  if (Math.max(...times) - Math.min(...times) < FOUR_MIN_SPREAD_MS) return reject('inhuman_timing', 'think times are all the same')
  return PASS
}

/**
 * Start positions for self-play: every position the human reached after the opening (ply 4 on) and before
 * the game ended, as the column list that leads there. Position k is the first k moves of the match.
 */
export function fourStartPositions(r: MatchRecordV1, minPly = 4): number[][] {
  const moves = fourMoves(r)
  const out: number[][] = []
  for (let k = minPly; k < moves.length - 1; k++) out.push(moves.slice(0, k))
  return out
}
