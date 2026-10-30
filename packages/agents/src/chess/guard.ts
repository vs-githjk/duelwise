// Tactical guard for the human-style policy levels (Easy, Medium). A policy net trained on human games plays like
// a human of its band, including the blunders a human makes in a lost-for-words moment: it can miss a mate in one or
// hang a queen. The labels promise a beginner (Easy) and a club player (Medium), not a player who misses a one-move
// mate, so Easy, Medium and Hard run these checks over the net's move list:
//   - findMateInOne: always play a move that checkmates now.
//   - safeMoves: drop a move when, after the opponent's best reply plus captures (depth 2 then quiescence, material only),
//     it scores `margin` points or more below the best move.
// Also here: nucleus (top-p) filtering of a probability vector, used by Easy so it never draws a very unlikely move.

import { Board, KING, moveFrom, moveTo, pieceColor, pieceType, type Move } from './board'

const VALUE = [0, 1, 3, 3, 5, 9, 0]
const MATED = -1000
const QS_MAX_PLY = 8

/** A legal move after which the opponent is in check with no legal reply, or null. The board is left as it was. */
export function findMateInOne(board: Board, legal: readonly Move[]): Move | null {
  for (const m of legal) {
    if (!board.make(m)) continue
    const mate = board.inCheck() && board.legalMoves().length === 0
    board.unmake()
    if (mate) return m
  }
  return null
}

/** Material from the side to move's view, in pawns (N=B=3, R=5, Q=9). */
function material(b: Board): number {
  let s = 0
  for (let i = 0; i < 64; i++) {
    const c = b.sq[i]!
    if (c === 0) continue
    const t = pieceType(c)
    if (t === KING) continue
    s += pieceColor(c) === b.side ? VALUE[t]! : -VALUE[t]!
  }
  return s
}

const scratch: Int32Array[] = Array.from({ length: QS_MAX_PLY + 2 }, () => new Int32Array(256))
const scratchKey: Int32Array[] = Array.from({ length: QS_MAX_PLY + 2 }, () => new Int32Array(256))
const replyBuf = new Int32Array(256)
const replyKey = new Int32Array(256)

/** Make calls one safeMoves call may spend. Ordinary middlegames use 2k to 6k; Kiwipete about 14k. */
export const GUARD_NODE_BUDGET = 20000
let nodes = 0
let limit = 0

/** Make calls the last safeMoves call spent (for tests). */
export const lastGuardNodes = (): number => nodes

/** Most valuable victim first, then the least valuable attacker. Quiet moves sort last. */
function orderKey(b: Board, m: Move): number {
  const victim = b.sq[moveTo(m)]!
  const v = victim === 0 ? 0 : 1 + VALUE[pieceType(victim)]!
  return v === 0 ? 0 : v * 16 - VALUE[pieceType(b.sq[moveFrom(m)]!)]! + 8
}

/** Sorts buf[0..n) by descending key (insertion sort: n is small). */
function sortByKey(buf: Int32Array, keys: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const m = buf[i]!
    const k = keys[i]!
    let j = i - 1
    while (j >= 0 && keys[j]! < k) {
      buf[j + 1] = buf[j]!
      keys[j + 1] = keys[j]!
      j--
    }
    buf[j + 1] = m
    keys[j + 1] = k
  }
}

function quiesce(b: Board, alpha: number, beta: number, ply: number): number {
  const stand = material(b)
  if (ply >= QS_MAX_PLY || nodes >= limit) return stand
  if (stand >= beta) return stand
  if (stand > alpha) alpha = stand
  const buf = scratch[ply]!
  const keys = scratchKey[ply]!
  const n = b.generate(buf, true)
  for (let i = 0; i < n; i++) keys[i] = orderKey(b, buf[i]!)
  sortByKey(buf, keys, n)
  let best = stand
  for (let i = 0; i < n; i++) {
    if (!b.make(buf[i]!)) continue
    nodes++
    const v = -quiesce(b, -beta, -alpha, ply + 1)
    b.unmake()
    if (v > best) best = v
    if (v > alpha) alpha = v
    if (alpha >= beta) break
  }
  return best
}

/** The side to move's score after its best reply plus captures, from that side's view. It stops early and returns
 *  a value >= `beta` as soon as one reply reaches `beta` (fail-soft); otherwise the value is exact. */
function replyValue(b: Board, beta: number): number {
  const n = b.generate(replyBuf, false)
  // Not reentrant across plies: each root move finishes its replies before the next starts.
  for (let i = 0; i < n; i++) replyKey[i] = orderKey(b, replyBuf[i]!)
  sortByKey(replyBuf, replyKey, n)
  const moves = Array.from(replyBuf.subarray(0, n))
  let best = -10000
  let legal = 0
  for (const m of moves) {
    if (!b.make(m)) continue
    legal++
    nodes++
    // A reply that checkmates the side that just moved is worth a win to the replier; material alone cannot see it.
    const v = b.inCheck() && b.legalMoves().length === 0 ? -MATED : -quiesce(b, -beta, -best, 0)
    b.unmake()
    if (v > best) best = v
    if (best >= beta) return best
    if (nodes >= limit) return best
  }
  if (legal === 0) return b.inCheck() ? MATED : 0
  return best
}

/** The moves of `legal` that do not lose `margin` points or more, judged at depth 2 plus quiescence.
 *  "Lose" is measured against the position as it stands (captures settled) or the best move, whichever is lower, so a
 *  quiet move in a quiet position is never dropped for failing to win material. Always keeps at least the best move.
 *  Work is bounded by GUARD_NODE_BUDGET: moves not checked in time stay in. The board is left as it was. */
export function safeMoves(board: Board, legal: readonly Move[], margin = 3, budget = GUARD_NODE_BUDGET): Move[] {
  if (legal.length < 2) return legal.slice()
  nodes = 0
  limit = budget
  const floorBase = quiesce(board, -10000, 10000, 0) - margin
  const pass = (floorOf: (best: number) => number): { keep: Move[]; best: number } => {
    const scores: number[] = []
    let best = -10000
    for (const m of legal) {
      if (nodes >= limit) {
        scores.push(NaN) // unchecked: kept
        continue
      }
      board.make(m)
      // Our value <= floor means the opponent's value >= -floor: that is the cutoff.
      const floor = floorOf(best)
      const opp = replyValue(board, -floor)
      board.unmake()
      const ours = nodes >= limit && opp < -floor ? NaN : -opp
      scores.push(ours)
      if (ours > best) best = ours
    }
    const keep = legal.filter((_, i) => Number.isNaN(scores[i]!) || scores[i]! > floorOf(best))
    return { keep, best }
  }
  const first = pass(() => floorBase)
  if (first.keep.length > 0) return first.keep
  // Every move loses material (a lost position): fall back to the moves within margin of the best one.
  return pass((best) => best - margin).keep
}

/** Keeps the most likely moves whose probabilities add up to `topP`, zeroes the rest and renormalises. */
export function nucleus(p: Float64Array, topP: number): Float64Array {
  if (topP >= 1) return p
  const order = Array.from(p.keys()).sort((a, b) => p[b]! - p[a]!)
  const out = new Float64Array(p.length)
  let mass = 0
  for (const i of order) {
    out[i] = p[i]!
    mass += p[i]!
    if (mass >= topP - 1e-12) break
  }
  for (let i = 0; i < out.length; i++) out[i]! /= mass
  return out
}
