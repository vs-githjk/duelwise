import type { FeatureEncoder } from '../../types'
import type { ChessObservation } from './core'
import { parsePosition, toPerspective, type RelPosition } from './position'

/**
 * Value-net input: 768 binary features = 12 piece kinds x 64 squares, from the mover's side
 * (feature = (pieceCode - 1) * 64 + relativeSquare, pieceCode as in position.ts: own P..K are
 * 0..5, opponent P..K are 6..11). At most 32 are on.
 */
export const SPARSE_FEATURES = 768
export const MAX_ACTIVE = 32

/** Active features of a relative position, ascending. */
export function sparseFromRel(r: RelPosition): Uint16Array {
  const out: number[] = []
  for (let kind = 0; kind < 12; kind++) {
    for (let s = 0; s < 64; s++) if (r.board[s] === kind + 1) out.push(kind * 64 + s)
  }
  return Uint16Array.from(out)
}

export function sparseIndices(o: ChessObservation): Uint16Array {
  return sparseFromRel(toPerspective(parsePosition(o.fen)))
}

export const chessSparseEncoder: FeatureEncoder<ChessObservation> = {
  shape: [SPARSE_FEATURES],
  encode(o, out, offset) {
    out.fill(0, offset, offset + SPARSE_FEATURES)
    for (const i of sparseIndices(o)) out[offset + i] = 1
  },
}
