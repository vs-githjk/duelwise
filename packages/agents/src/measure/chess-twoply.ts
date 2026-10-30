import { encodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import type { ChessObservation } from '@duelwise/core/src/games/chess/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { Board, KING, movePromo, moveToUci, pieceColor, pieceType, PAWN, QUEEN, WHITE, type Move } from '../chess/board'

// The 2-ply bot of the round-3 judge, ported so the publish gate plays what the judge played: minimax to depth 2
// with a capture-only quiescence (6 plies), material plus a centre and pawn-advance bonus, and a random pick among the
// moves within NOISE centipawns of the best. No net, no book. Hard must beat it (publish gate, measure/chess.ts).

const VALUE = [0, 100, 310, 320, 500, 900, 0]
const MATE = 100000
const NOISE = 20
const QS_DEPTH = 6

const centre = (file: number, rank: number): number => 6 - (Math.abs(3.5 - file) + Math.abs(4.5 - rank))

/** Static score from the side to move's view. */
function evalSide(b: Board): number {
  let s = 0
  for (let sq = 0; sq < 64; sq++) {
    const c = b.sq[sq]!
    if (c === 0) continue
    const t = pieceType(c)
    const white = pieceColor(c) === WHITE
    const file = sq & 7
    const rank = (sq >> 3) + 1
    let v = VALUE[t]!
    if (t !== KING && t !== QUEEN) v += centre(file, rank) * (t === PAWN ? 2 : 4)
    if (t === PAWN) v += (white ? rank - 2 : 7 - rank) * 6
    s += white ? v : -v
  }
  return b.side === WHITE ? s : -s
}

const captureValue = (b: Board, m: Move): number => {
  const victim = b.sq[(m >> 6) & 63]!
  return victim === 0 ? 0 : VALUE[pieceType(victim)]!
}

function quiesce(b: Board, alpha: number, beta: number, depth: number): number {
  const stand = evalSide(b)
  if (stand >= beta) return stand
  if (stand > alpha) alpha = stand
  if (depth > QS_DEPTH) return stand
  const caps = b.legalMoves().filter((m) => captureValue(b, m) > 0 || movePromo(m) !== 0)
  caps.sort((x, y) => captureValue(b, y) - captureValue(b, x))
  for (const m of caps) {
    b.make(m)
    const v = -quiesce(b, -beta, -alpha, depth + 1)
    b.unmake()
    if (v >= beta) return v
    if (v > alpha) alpha = v
  }
  return alpha
}

function negamax(b: Board, depth: number, alpha: number, beta: number): number {
  const moves = b.legalMoves()
  if (moves.length === 0) return b.inCheck() ? -MATE : 0
  if (depth === 0) return quiesce(b, alpha, beta, 0)
  moves.sort((x, y) => captureValue(b, y) - captureValue(b, x))
  let best = -1e9
  for (const m of moves) {
    b.make(m)
    const v = -negamax(b, depth - 1, -beta, -alpha)
    b.unmake()
    if (v > best) best = v
    if (v > alpha) alpha = v
    if (alpha >= beta) break
  }
  return best
}

/** Every legal move (queen promotions only) with its depth-2 score. Exported for tests. */
export function scoreMoves(b: Board): Array<{ move: Move; score: number }> {
  return b
    .legalMoves()
    .filter((m) => movePromo(m) === 0 || movePromo(m) === QUEEN)
    .map((move) => {
      b.make(move)
      const score = -negamax(b, 1, -1e9, 1e9)
      b.unmake()
      return { move, score }
    })
}

export async function createGameAgent(_level: Level, _opts?: AgentOpts): Promise<PreviewAgent> {
  let rng = makeRng(0)
  return {
    preview: false,
    reset(seed) {
      rng = makeRng(seed)
    },
    async act(obs) {
      const b = Board.fromFen((obs as ChessObservation).fen)
      const scored = scoreMoves(b)
      const top = Math.max(...scored.map((x) => x.score))
      const pool = scored.filter((x) => x.score >= top - NOISE)
      return [encodeAbs(moveToUci(pool[rng.int(pool.length)]!.move))]
    },
    dispose() {},
  }
}
