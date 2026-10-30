import type { FeatureEncoder } from '../../types'
import type { ChessObservation } from './core'
import { parsePosition, toPerspective, type RelPosition } from './position'

/**
 * Policy-net input, from the mover's side (the board is flipped when black is to move, so
 * "own" pieces always start at the bottom). 18 planes of 8 x 8, plane p at offset p * 64,
 * square index = rank * 8 + file:
 *   0..5   own P N B R Q K       6..11  opponent P N B R Q K
 *   12     own kingside right (all 1s)    13  own queenside    14  opponent kingside    15  opponent queenside
 *   16     en passant target square (one-hot)
 *   17     halfmove clock / 100 (constant plane)
 */
export const PLANES = 18

export function encodeRel(r: RelPosition, out: Float32Array, offset: number): void {
  out.fill(0, offset, offset + PLANES * 64)
  for (let s = 0; s < 64; s++) {
    const c = r.board[s]!
    if (c !== 0) out[offset + (c - 1) * 64 + s] = 1
  }
  for (let i = 0; i < 4; i++) {
    if ((r.castling >> i) & 1) out.fill(1, offset + (12 + i) * 64, offset + (13 + i) * 64)
  }
  if (r.ep >= 0) out[offset + 16 * 64 + r.ep] = 1
  out.fill(r.halfmove / 100, offset + 17 * 64, offset + 18 * 64)
}

export const chessPlaneEncoder: FeatureEncoder<ChessObservation> = {
  shape: [PLANES, 8, 8],
  encode(o, out, offset) {
    encodeRel(toPerspective(parsePosition(o.fen)), out, offset)
  },
}
