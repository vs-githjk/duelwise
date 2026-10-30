// Champion search: iterative-deepening principal variation search (PVS) with a transposition table,
// quiescence search over captures (MVV-LVA ordered), killer and history ordering, a null move, check
// extensions and light late move reductions. Leaves are scored by the TypeScript value net (value-eval.ts),
// as logit * 100 from the side to move. Scores are integers; a mate is MATE minus the plies to it.
//
// Budgets: `nodeBudget` (deterministic, used by the measurement ladder) and `timeCapMs` (used on the site).
// Depth 1 always completes, so a move is always returned.

import { Board, KNIGHT, PAWN, QUEEN, moveFrom, moveTo, movePromo, moveToUci, pieceType, type Move } from './board'
import type { ValueNet } from './value-eval'

export const MATE = 20000
const INF = 30000
const MAX_PLY = 96
const EVAL_CLAMP = 5000
const EVAL_SCALE = 100

export interface SearchOpts {
  maxDepth?: number
  /** Stop after about this many nodes (checked at every node), once depth 1 is done. */
  nodeBudget?: number
  /** Stop after this many milliseconds, once depth 1 is done. */
  timeCapMs?: number
  /** FEN position keys (first four fields) played before the root, for repetition draws. */
  priorKeys?: readonly string[]
}

export interface SearchResult {
  move: Move
  uci: string
  /** Score for the side to move in logit/100 units; |score| above MATE - 1000 is a forced mate. */
  score: number
  depth: number
  nodes: number
  elapsedMs: number
  /** Why the search ended. */
  ended: 'depth' | 'nodes' | 'time' | 'mate' | 'only-move'
}

const FLAG_EXACT = 1
const FLAG_LOWER = 2
const FLAG_UPPER = 3
const VALUE = [0, 1, 3, 3, 5, 9, 0]

const keyOf = (lo: number, hi: number): number => (hi & 0x1fffff) * 4294967296 + (lo >>> 0)

export class Searcher {
  private readonly ttMask: number
  private readonly ttHi: Int32Array
  private readonly ttMove: Int32Array
  private readonly ttScore: Int16Array
  private readonly ttDepth: Int8Array
  private readonly ttFlag: Uint8Array
  private readonly moves: Int32Array[] = Array.from({ length: MAX_PLY + 2 }, () => new Int32Array(256))
  private readonly order: Int32Array[] = Array.from({ length: MAX_PLY + 2 }, () => new Int32Array(256))
  private readonly killers = new Int32Array((MAX_PLY + 2) * 2)
  private readonly history = new Int32Array(2 * 64 * 64)

  private b!: Board
  private nodes = 0
  private stopped = false
  private nodeBudget = Infinity
  private deadline = Infinity
  private prior = new Set<number>()
  private rootDone = false

  constructor(
    private readonly net: ValueNet,
    ttBits = 18,
  ) {
    const size = 1 << ttBits
    this.ttMask = size - 1
    this.ttHi = new Int32Array(size)
    this.ttMove = new Int32Array(size)
    this.ttScore = new Int16Array(size)
    this.ttDepth = new Int8Array(size)
    this.ttFlag = new Uint8Array(size)
  }

  clear(): void {
    this.ttFlag.fill(0)
    this.history.fill(0)
    this.killers.fill(0)
  }

  /** Searches the position and returns the best move. `fen` must have a legal move. */
  search(fen: string, opts: SearchOpts = {}): SearchResult {
    const t0 = performance.now()
    const b = Board.fromFen(fen)
    this.b = b
    this.nodes = 0
    this.stopped = false
    this.rootDone = false
    this.nodeBudget = opts.nodeBudget ?? Infinity
    this.deadline = opts.timeCapMs === undefined ? Infinity : t0 + opts.timeCapMs
    this.prior = new Set()
    for (const k of opts.priorKeys ?? []) {
      const pb = Board.fromFen(k + ' 0 1')
      this.prior.add(keyOf(pb.hashLo, pb.hashHi))
    }
    this.history.forEach((v, i, a) => (a[i] = v >> 1))
    this.killers.fill(0)

    const root = b.legalMoves()
    if (root.length === 0) throw new Error('search: no legal move in ' + fen)
    const maxDepth = Math.min(opts.maxDepth ?? 64, MAX_PLY - 8)
    if (root.length === 1) {
      return { move: root[0]!, uci: moveToUci(root[0]!), score: 0, depth: 0, nodes: 0, elapsedMs: performance.now() - t0, ended: 'only-move' }
    }

    let best = root[0]!
    let bestScore = -INF
    let depthDone = 0
    let ended: SearchResult['ended'] = 'depth'
    const rootScore = new Map<Move, number>()
    for (let depth = 1; depth <= maxDepth; depth++) {
      root.sort((x, y) => (x === best ? -1 : y === best ? 1 : (rootScore.get(y) ?? -INF) - (rootScore.get(x) ?? -INF)))
      let alpha = -INF
      let iterBest = root[0]!
      let iterScore = -INF
      for (let i = 0; i < root.length; i++) {
        const m = root[i]!
        b.make(m)
        let score: number
        if (i === 0) score = -this.negamax(depth - 1, -INF, -alpha, 1, true, true)
        else {
          score = -this.negamax(depth - 1, -alpha - 1, -alpha, 1, false, true)
          if (score > alpha && !this.stopped) score = -this.negamax(depth - 1, -INF, -alpha, 1, true, true)
        }
        b.unmake()
        if (this.stopped && depth > 1) break
        rootScore.set(m, score)
        if (score > iterScore) {
          iterScore = score
          iterBest = m
        }
        if (score > alpha) alpha = score
      }
      if (this.stopped && depth > 1) {
        ended = this.nodes >= this.nodeBudget ? 'nodes' : 'time'
        break
      }
      best = iterBest
      bestScore = iterScore
      depthDone = depth
      this.rootDone = true
      if (Math.abs(bestScore) > MATE - 1000 && MATE - Math.abs(bestScore) <= depth) {
        ended = 'mate'
        break
      }
      if (this.nodes >= this.nodeBudget) {
        ended = 'nodes'
        break
      }
      if (performance.now() >= this.deadline) {
        ended = 'time'
        break
      }
    }
    return { move: best, uci: moveToUci(best), score: bestScore, depth: depthDone, nodes: this.nodes, elapsedMs: performance.now() - t0, ended }
  }

  private checkStop(): void {
    if (!this.rootDone) return
    if (this.nodes >= this.nodeBudget) this.stopped = true
    else if ((this.nodes & 1023) === 0 && performance.now() >= this.deadline) this.stopped = true
  }

  private evaluate(): number {
    const z = this.net.evaluate(this.b) * EVAL_SCALE
    return z > EVAL_CLAMP ? EVAL_CLAMP : z < -EVAL_CLAMP ? -EVAL_CLAMP : Math.round(z)
  }

  private isDraw(ply: number): boolean {
    const b = this.b
    if (b.halfmove >= 100) return true
    const lo = b.hashLo
    const hi = b.hashHi
    // Positions with the same side to move are an even number of plies back, no further than the last irreversible move.
    const limit = Math.max(0, b.ply - b.halfmove)
    for (let i = b.ply - 2; i >= limit; i -= 2) if (b.hLo[i] === lo && b.hHi[i] === hi) return true
    if (b.halfmove >= 4 && this.prior.size > 0 && this.prior.has(keyOf(lo, hi))) return true
    return b.insufficientMaterial()
  }

  private score(ply: number, n: number, ttMove: Move): void {
    const b = this.b
    const mv = this.moves[ply]!
    const ord = this.order[ply]!
    const k0 = this.killers[ply * 2]!
    const k1 = this.killers[ply * 2 + 1]!
    const side = b.side
    for (let i = 0; i < n; i++) {
      const m = mv[i]!
      if (m === ttMove) {
        ord[i] = 1_000_000
        continue
      }
      const from = moveFrom(m)
      const to = moveTo(m)
      const victim = b.sq[to]!
      const attacker = pieceType(b.sq[from]!)
      const promo = movePromo(m)
      let s: number
      if (victim !== 0) s = 100_000 + VALUE[pieceType(victim)]! * 16 - attacker
      else if (attacker === PAWN && (from & 7) !== (to & 7)) s = 100_000 + 16 - 1 // en passant
      else if (m === k0) s = 90_000
      else if (m === k1) s = 89_000
      else s = this.history[(side * 64 + from) * 64 + to]!
      if (promo !== 0) s += promo === QUEEN ? 150_000 : promo === KNIGHT ? 20_000 : -50_000
      ord[i] = s
    }
  }

  /** Moves the best-scored move at or after `i` into slot `i` (selection sort, lazily). */
  private pick(ply: number, i: number, n: number): Move {
    const mv = this.moves[ply]!
    const ord = this.order[ply]!
    let bi = i
    for (let j = i + 1; j < n; j++) if (ord[j]! > ord[bi]!) bi = j
    if (bi !== i) {
      const m = mv[bi]!
      mv[bi] = mv[i]!
      mv[i] = m
      const s = ord[bi]!
      ord[bi] = ord[i]!
      ord[i] = s
    }
    return mv[i]!
  }

  private negamax(depth: number, alpha: number, beta: number, ply: number, pv: boolean, nullOk: boolean): number {
    const b = this.b
    this.nodes++
    this.checkStop()
    if (this.stopped) return 0
    if (this.isDraw(ply)) return 0
    if (ply >= MAX_PLY) return this.evaluate()
    const inChk = b.inCheck()
    if (inChk) depth++
    if (depth <= 0) return this.qsearch(alpha, beta, ply)

    // Transposition table.
    const idx = b.hashLo & this.ttMask
    let ttMove = 0
    if (this.ttFlag[idx] !== 0 && this.ttHi[idx] === b.hashHi) {
      ttMove = this.ttMove[idx]!
      if (!pv && this.ttDepth[idx]! >= depth) {
        let s = this.ttScore[idx]!
        if (s > MATE - 1000) s -= ply
        else if (s < -MATE + 1000) s += ply
        const f = this.ttFlag[idx]!
        if (f === FLAG_EXACT) return s
        if (f === FLAG_LOWER && s >= beta) return s
        if (f === FLAG_UPPER && s <= alpha) return s
      }
    }

    // Null move: hand the opponent a free move; if still above beta, cut.
    if (!pv && !inChk && nullOk && depth >= 3 && b.hasPieces(b.side)) {
      b.makeNull()
      const r = depth >= 6 ? 3 : 2
      const s = -this.negamax(depth - 1 - r, -beta, -beta + 1, ply + 1, false, false)
      b.unmakeNull()
      if (this.stopped) return 0
      if (s >= beta) return s >= MATE - 1000 ? beta : s
    }

    const mv = this.moves[ply]!
    const n = b.generate(mv)
    this.score(ply, n, ttMove)
    const alphaStart = alpha
    let best = -INF
    let bestMove = 0
    let legal = 0
    for (let i = 0; i < n; i++) {
      const m = this.pick(ply, i, n)
      const capture = b.sq[moveTo(m)] !== 0 || (pieceType(b.sq[moveFrom(m)]!) === PAWN && (moveFrom(m) & 7) !== (moveTo(m) & 7) && b.sq[moveTo(m)] === 0)
      if (!b.make(m)) continue
      legal++
      let score: number
      const givesCheck = depth >= 3 && b.inCheck()
      if (legal === 1) score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, pv, true)
      else {
        let red = 0
        if (depth >= 3 && legal > 4 && !capture && !inChk && !givesCheck && movePromo(m) === 0) red = 1 + (legal > 12 ? 1 : 0)
        score = -this.negamax(depth - 1 - red, -alpha - 1, -alpha, ply + 1, false, true)
        if (score > alpha && red > 0) score = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1, false, true)
        if (score > alpha && score < beta && pv) score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true, true)
      }
      b.unmake()
      if (this.stopped) return 0
      if (score > best) {
        best = score
        bestMove = m
        if (score > alpha) {
          alpha = score
          if (alpha >= beta) {
            if (!capture && movePromo(m) === 0) {
              if (this.killers[ply * 2] !== m) {
                this.killers[ply * 2 + 1] = this.killers[ply * 2]!
                this.killers[ply * 2] = m
              }
              const h = b.side * 4096 + moveFrom(m) * 64 + moveTo(m)
              this.history[h] = Math.min(80_000, this.history[h]! + depth * depth)
            }
            break
          }
        }
      }
    }
    if (legal === 0) return inChk ? -MATE + ply : 0

    const flag = best >= beta ? FLAG_LOWER : best > alphaStart ? FLAG_EXACT : FLAG_UPPER
    if (this.ttFlag[idx] === 0 || this.ttDepth[idx]! <= depth || this.ttHi[idx] !== b.hashHi) {
      let s = best
      if (s > MATE - 1000) s += ply
      else if (s < -MATE + 1000) s -= ply
      this.ttHi[idx] = b.hashHi
      this.ttMove[idx] = bestMove
      this.ttScore[idx] = s
      this.ttDepth[idx] = depth > 100 ? 100 : depth
      this.ttFlag[idx] = flag
    }
    return best
  }

  private qsearch(alpha: number, beta: number, ply: number): number {
    const b = this.b
    this.nodes++
    this.checkStop()
    if (this.stopped) return 0
    if (ply >= MAX_PLY) return this.evaluate()
    const inChk = b.inCheck()
    let best = -INF
    if (!inChk) {
      best = this.evaluate()
      if (best >= beta) return best
      if (best > alpha) alpha = best
    }
    const mv = this.moves[ply]!
    const n = b.generate(mv, !inChk)
    this.score(ply, n, 0)
    let legal = 0
    for (let i = 0; i < n; i++) {
      const m = this.pick(ply, i, n)
      if (!b.make(m)) continue
      legal++
      const score = -this.qsearch(-beta, -alpha, ply + 1)
      b.unmake()
      if (this.stopped) return 0
      if (score > best) {
        best = score
        if (score > alpha) {
          alpha = score
          if (alpha >= beta) break
        }
      }
    }
    if (inChk && legal === 0) return -MATE + ply
    return best
  }
}

/** Convenience wrapper for tests and tools: one search with a fresh table. */
export function bestMove(net: ValueNet, fen: string, opts: SearchOpts = {}, ttBits = 16): SearchResult {
  return new Searcher(net, ttBits).search(fen, opts)
}
