// Repetition avoidance for the policy levels (Medium, Hard): a human-style policy net knows nothing about the draw
// by repetition, so a won game could end in a shuffle. When the value net says the side to move is clearly ahead,
// moves that recreate a position already seen in this game are dropped, unless every legal move repeats.
// (The Champion's search already scores a repeat as a draw, see alphabeta.ts priorKeys.)

import { Board, type Move } from './board'
import type { ValueNet } from './value-eval'

/** "Ahead" means the net's logit for the side to move is at least this (an expected score of about 0.73). */
export const AHEAD_LOGIT = 1.0

const keyOf = (lo: number, hi: number): number => (hi & 0x1fffff) * 4294967296 + (lo >>> 0)

/** `legal` without the moves that repeat a position from `priorKeys` (FEN position keys, first four fields),
 *  when `net` rates the side to move at `aheadLogit` or better. Returns `legal` unchanged otherwise, or when
 *  no non-repeating move exists. The board is left as it was. */
export function nonRepeatingMoves(
  board: Board,
  legal: readonly Move[],
  priorKeys: readonly string[] | undefined,
  net: ValueNet | undefined,
  aheadLogit: number = AHEAD_LOGIT,
): Move[] {
  if (!net || !priorKeys || priorKeys.length === 0 || legal.length < 2) return legal.slice()
  if (net.evaluate(board) < aheadLogit) return legal.slice()
  const seen = new Set<number>()
  for (const k of priorKeys) {
    const pb = Board.fromFen(k + ' 0 1')
    seen.add(keyOf(pb.hashLo, pb.hashHi))
  }
  const keep: Move[] = []
  for (const m of legal) {
    if (!board.make(m)) continue
    if (!seen.has(keyOf(board.hashLo, board.hashHi))) keep.push(m)
    board.unmake()
  }
  return keep.length > 0 ? keep : legal.slice()
}
