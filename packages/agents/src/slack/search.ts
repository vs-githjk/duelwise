import { PASS } from '@duelwise/core/src/games/slack/core'
import type { Seat } from '@duelwise/core/src/types'
import {
  CELLS, ORDER, WEIGHTS, discDiff, emptyCount, fromCells, legalInto, make, moveCount, unmake,
} from './board'

/**
 * Slackwater search: iterative deepening negamax with alpha-beta, move order by square weight (best
 * move of the last depth first at the root), a node count, and an optional exact solve of the last
 * few empties. Integer scores only, so a position always scores the same.
 */

/** The node counter is checked on every node, so a cap is passed by at most this many. */
export const NODE_BATCH = 1

/** A finished game scores its disc difference times this, far above any heuristic value. */
const END_SCALE = 10000
const INF = 1_000_000_000
/** Deep enough to reach the end of any game: the exact stage. */
const EXACT_DEPTH = 99
const MAX_PLY = 160

export interface SearchOpts {
  /** Deepest iteration tried. */
  maxDepth: number
  /** Add a mobility term (placements mine minus theirs) to the square weights. */
  mobility?: boolean
  /** Integer noise: each root move gets a draw in 0..noise added to its value. Needs `rng`. */
  noise?: number
  rng?: { int(n: number): number }
  /** Solve to the end of the game when this many cells or fewer are empty. */
  exactEmpties?: number
  /** Stop after this many nodes and answer with the last finished depth. */
  nodeCap?: number
}

export interface SearchResult {
  /** A cell 0..63, or PASS when the seat has no placement. */
  move: number
  /** Value of `move` for the seat, without noise. Disc difference times 10000 when exact. */
  value: number
  /** Last depth that finished (0: none finished, move is the best-ordered legal move). */
  depth: number
  nodes: number
  /** True when the answer came from the exact solve. */
  exact: boolean
}

/** Static value for `me` to move: square weights, plus mobility if asked. */
export function evaluate(b: Int8Array, me: number, mobility: boolean): number {
  let s = 0
  for (let p = 0; p < CELLS; p++) s += b[p]! * WEIGHTS[p]!
  s *= me
  if (!mobility) return s
  const mob = moveCount(b, me) - moveCount(b, -me)
  return s + (emptyCount(b) > 20 ? 6 : 3) * mob
}

class CapReached extends Error {}

interface Ctx {
  nodes: number
  cap: number
  mobility: boolean
  moves: Int8Array[]
  flips: Int8Array[]
}

function negamax(ctx: Ctx, b: Int8Array, me: number, depth: number, alpha: number, beta: number, passed: boolean, ply: number): number {
  if (++ctx.nodes > ctx.cap) throw new CapReached()
  if (depth === 0) return evaluate(b, me, ctx.mobility)
  const buf = ctx.moves[ply]!
  const n = legalInto(b, me, buf)
  if (n === 0) {
    if (passed) return discDiff(b, me) * END_SCALE
    // A pass uses no depth: it is not a move anyone chose.
    return -negamax(ctx, b, -me, depth, -beta, -alpha, true, ply + 1)
  }
  const fl = ctx.flips[ply]!
  let best = -INF
  for (let i = 0; i < n; i++) {
    const m = buf[i]!
    const k = make(b, m, me, fl)
    const v = -negamax(ctx, b, -me, depth - 1, -beta, -alpha, false, ply + 1)
    unmake(b, m, me, fl, k)
    if (v > best) best = v
    if (v > alpha) alpha = v
    if (alpha >= beta) break
  }
  return best
}

/** One root iteration on a fresh board. Throws CapReached if the cap hits mid-way. */
function rootPass(ctx: Ctx, cells: readonly number[], me: number, roots: number[], depth: number, noise: Int16Array | null): { move: number; value: number } {
  const b = fromCells(cells)
  const fl = ctx.flips[0]!
  let bestMove = roots[0]!
  let bestRaw = -INF
  let bestScored = -INF
  for (const m of roots) {
    const k = make(b, m, me, fl)
    // With noise every root value must be exact. Without, a child only needs to beat the best so far.
    const raw = -negamax(ctx, b, -me, depth - 1, -INF, noise ? INF : -bestScored, false, 1)
    unmake(b, m, me, fl, k)
    const scored = raw + (noise ? noise[m]! : 0)
    if (scored > bestScored) {
      bestScored = scored
      bestRaw = raw
      bestMove = m
    }
  }
  return { move: bestMove, value: bestRaw }
}

export function searchMove(cells: readonly number[], seat: Seat, opts: SearchOpts): SearchResult {
  const me = seat === 0 ? 1 : -1
  const mobility = opts.mobility ?? false
  const ctx: Ctx = {
    nodes: 0,
    cap: opts.nodeCap ?? Infinity,
    mobility,
    moves: Array.from({ length: MAX_PLY }, () => new Int8Array(CELLS)),
    flips: Array.from({ length: MAX_PLY }, () => new Int8Array(CELLS)),
  }
  const board = fromCells(cells)
  const rootBuf = new Int8Array(CELLS)
  const count = legalInto(board, me, rootBuf)
  if (count === 0) return { move: PASS, value: evaluate(board, me, mobility), depth: 0, nodes: 0, exact: false }
  let roots = Array.from(rootBuf.subarray(0, count))

  const noiseMax = opts.noise ?? 0
  let noise: Int16Array | null = null
  if (noiseMax > 0) {
    if (!opts.rng) throw new Error('slack search: noise needs an rng')
    // Drawn once per root move in cell order, so it does not depend on how deep the search got.
    noise = new Int16Array(CELLS)
    for (const m of [...roots].sort((x, y) => x - y)) noise[m] = opts.rng.int(noiseMax + 1)
  }

  // The answer until a depth finishes: the best-ordered legal move.
  let answer: SearchResult = { move: roots[0]!, value: 0, depth: 0, nodes: 0, exact: false }
  const empties = emptyCount(board)
  const exactNow = opts.exactEmpties !== undefined && empties <= opts.exactEmpties

  try {
    for (let d = 1; d <= opts.maxDepth; d++) {
      const r = rootPass(ctx, cells, me, roots, d, noise)
      answer = { move: r.move, value: r.value, depth: d, nodes: ctx.nodes, exact: false }
      roots = [r.move, ...roots.filter((m) => m !== r.move)]
    }
    if (exactNow) {
      // Exact values are win/draw/loss margins; noise would only blur a known result.
      const r = rootPass(ctx, cells, me, roots, EXACT_DEPTH, null)
      answer = { move: r.move, value: r.value, depth: answer.depth, nodes: ctx.nodes, exact: true }
    }
  } catch (e) {
    if (!(e instanceof CapReached)) throw e
  }
  answer.nodes = ctx.nodes
  return answer
}
