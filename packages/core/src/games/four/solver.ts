import { COLS, ROWS, bitOf, computeWinCells, hasFour, popcount32, shrHi, shrLo, type FourState } from './rules'
import * as rules from './rules'

// Perfect solver for Four in a Row: negamax with alpha-beta, bitboards as (lo, hi) pairs of
// 32-bit halves, a transposition table, null-window iterative search and move ordering that
// is centre-first, then by how many winning cells a move creates.
//
// Score (from the side to move): 0 is a draw; a win with the player's k-th stone is worth
// 22 - k (so winning on the very last possible stone is +1 and an early win is large);
// a loss is the negative of the opponent's win value. Written from the published
// description of the technique only.

export interface SolveOptions {
  /** log2 of transposition table entries (default 22). */
  ttBits?: number
  /**
   * Weak solve: only the outcome (+1 win, 0 draw, -1 loss for the side to move) and the moves
   * that keep it, which is far cheaper than the exact stone-count score.
   */
  weak?: boolean
  /** Give up (throw SolveLimitError) after this many search nodes. */
  maxNodes?: number
  /** Give up (throw SolveLimitError) once performance.now() passes this, checked every 1024 nodes. */
  deadline?: number
}

/** Thrown by solve() when maxNodes or deadline ran out before the position was solved. */
export class SolveLimitError extends Error {
  constructor() {
    super('solve: node or time budget exhausted')
  }
}

export interface SolveResult {
  /** Game-theoretic value for the side to move under perfect play (the sign only when weak). */
  score: number
  /** Columns that reach `score`, in ascending order. */
  bestMoves: number[]
  /** Search nodes visited. */
  nodes: number
}

const EXACT = 1
const LOWER = 2
const UPPER = 3
const CENTRE_FIRST = [3, 2, 4, 1, 5, 0, 6] as const
const BOTTOM_LO = (() => {
  let lo = 0
  for (let c = 0; c < COLS; c++) lo = (lo | bitOf(c, 0)[0]) >>> 0
  return lo
})()
const BOTTOM_HI = (() => {
  let hi = 0
  for (let c = 0; c < COLS; c++) hi = (hi | bitOf(c, 0)[1]) >>> 0
  return hi
})()
const TWO32 = 4294967296

class Searcher {
  nodes = 0
  maxNodes = Infinity
  deadline = Infinity
  readonly h = new Int8Array(COLS)
  /** Column-mirrored bitboards by seat: [seat 0 lo, seat 0 hi, seat 1 lo, seat 1 hi], toggled on make and unmake. */
  readonly mir = new Uint32Array(4)
  private readonly size: number
  private readonly shift: number
  private readonly keys: Float64Array
  private readonly vals: Int8Array
  private readonly flags: Uint8Array
  // per-ply move lists (ply = stones played, 0..41)
  private readonly order = new Int8Array(43 * COLS)
  private readonly scores = new Int8Array(COLS + 1)

  constructor(bits: number) {
    this.size = 1 << bits
    this.shift = 32 - bits
    this.keys = new Float64Array(this.size)
    this.vals = new Int8Array(this.size)
    this.flags = new Uint8Array(this.size)
  }

  /** Drops a stone for ply m (seat m & 1) in column c; the mirrored board toggles the same bit. */
  make(c: number, m: number): void {
    this.toggle(c, m)
    this.h[c] = this.h[c]! + 1
  }

  unmake(c: number, m: number): void {
    this.h[c] = this.h[c]! - 1
    this.toggle(c, m)
  }

  private toggle(c: number, m: number): void {
    const i = (COLS - 1 - c) * 7 + this.h[c]!
    if (i < 32) this.mir[(m & 1) * 2] = (this.mir[(m & 1) * 2]! ^ (1 << i)) >>> 0
    else this.mir[(m & 1) * 2 + 1] = (this.mir[(m & 1) * 2 + 1]! ^ (1 << (i - 32))) >>> 0
  }

  negamax(cLo: number, cHi: number, oLo: number, oHi: number, m: number, alpha: number, beta: number): number {
    if (++this.nodes > this.maxNodes || ((this.nodes & 1023) === 0 && performance.now() > this.deadline)) throw new SolveLimitError()
    const h = this.h
    // playable cells
    let pLo = 0
    let pHi = 0
    for (let c = 0; c < COLS; c++) {
      if (h[c]! < ROWS) {
        const i = c * 7 + h[c]!
        if (i < 32) pLo |= 1 << i
        else pHi |= 1 << (i - 32)
      }
    }
    pLo >>>= 0
    pHi >>>= 0

    // can I win now?
    computeWinCells(cLo, cHi)
    if ((rules.winLo & pLo) !== 0 || (rules.winHi & pHi) !== 0) return 21 - (m >> 1)
    if (m >= 41) return 0

    // opponent threats on playable cells
    computeWinCells(oLo, oHi)
    const owLo = rules.winLo
    const owHi = rules.winHi
    let forcedLo = (owLo & pLo) >>> 0
    let forcedHi = (owHi & pHi) >>> 0
    let candLo: number
    let candHi: number
    let min: number
    if (forcedLo !== 0 || forcedHi !== 0) {
      if (popcount32(forcedLo) + popcount32(forcedHi) > 1) return -(21 - ((m + 1) >> 1))
      candLo = forcedLo
      candHi = forcedHi
      min = -(21 - ((m + 1) >> 1))
    } else {
      // avoid moves that hand the opponent the cell above
      const aboveLo = shrLo(owLo, owHi, 1)
      const aboveHi = shrHi(owHi, 1)
      candLo = (pLo & ~aboveLo) >>> 0
      candHi = (pHi & ~aboveHi) >>> 0
      if (candLo === 0 && candHi === 0) return -(21 - ((m + 1) >> 1))
      min = -(21 - ((m + 3) >> 1))
    }
    const max = 21 - ((m + 2) >> 1)
    if (alpha < min) alpha = min
    if (beta > max) beta = max
    if (alpha >= beta) return alpha >= max ? max : alpha

    // transposition table (key = 2 * cur + opp + bottom row, unique per position)
    const keyNum = (2 * cHi + oHi + BOTTOM_HI) * TWO32 + (2 * cLo + oLo + BOTTOM_LO)
    // the mirrored position has the same value, so the smaller of the two keys is the table key
    const mir = this.mir
    const si = (m & 1) * 2
    const oi = 2 - si
    const mKey = (2 * mir[si + 1]! + mir[oi + 1]! + BOTTOM_HI) * TWO32 + (2 * mir[si]! + mir[oi]! + BOTTOM_LO)
    const key = mKey < keyNum ? mKey : keyNum
    const slot = (Math.imul(key >>> 0, 0x9e3779b1) ^ Math.imul((key / TWO32) | 0, 0x85ebca6b)) >>> this.shift
    const alpha0 = alpha
    const beta0 = beta
    if (this.keys[slot] === key) {
      const f = this.flags[slot]!
      const v = this.vals[slot]!
      if (f === EXACT) return v
      if (f === LOWER) {
        if (v >= beta) return v
        if (v > alpha) alpha = v
      } else {
        if (v <= alpha) return v
        if (v < beta) beta = v
      }
    }

    // order candidates: more created winning cells first, ties centre-first
    const base = m * COLS
    const order = this.order
    let cnt = 0
    const scores = this.scores
    for (let k = 0; k < COLS; k++) {
      const c = CENTRE_FIRST[k]!
      if (h[c]! >= ROWS) continue
      const i = c * 7 + h[c]!
      const bl = i < 32 ? (1 << i) >>> 0 : 0
      const bh = i < 32 ? 0 : (1 << (i - 32)) >>> 0
      if ((candLo & bl) === 0 && (candHi & bh) === 0) continue
      computeWinCells(cLo | bl, cHi | bh)
      const freeLo = ~(cLo | oLo | bl)
      const freeHi = ~(cHi | oHi | bh)
      const sc = popcount32((rules.winLo & freeLo) >>> 0) + popcount32((rules.winHi & freeHi) >>> 0)
      // insertion sort, stable so equal scores keep centre-first order
      let j = cnt
      while (j > 0 && scores[j - 1]! < sc) {
        scores[j] = scores[j - 1]!
        order[base + j] = order[base + j - 1]!
        j--
      }
      scores[j] = sc
      order[base + j] = c
      cnt++
    }

    let best = -100
    for (let k = 0; k < cnt; k++) {
      const c = order[base + k]!
      const i = c * 7 + h[c]!
      const bl = i < 32 ? (1 << i) >>> 0 : 0
      const bh = i < 32 ? 0 : (1 << (i - 32)) >>> 0
      this.make(c, m)
      const v = -this.negamax(oLo, oHi, (cLo | bl) >>> 0, (cHi | bh) >>> 0, m + 1, -beta, -alpha)
      this.unmake(c, m)
      if (v > best) best = v
      if (v > alpha) alpha = v
      if (alpha >= beta) break
    }

    this.keys[slot] = key
    this.vals[slot] = best
    this.flags[slot] = best <= alpha0 ? UPPER : best >= beta0 ? LOWER : EXACT
    return best
  }

  /** Outcome sign for the side to move via two null-window searches. */
  outcome(cLo: number, cHi: number, oLo: number, oHi: number, m: number): number {
    if (this.negamax(cLo, cHi, oLo, oHi, m, 0, 1) > 0) return 1
    return this.negamax(cLo, cHi, oLo, oHi, m, -1, 0) >= 0 ? 0 : -1
  }

  /** Exact value for the side to move via a null-window search. */
  exact(cLo: number, cHi: number, oLo: number, oHi: number, m: number): number {
    let lo = -(21 - ((m + 1) >> 1))
    let hi = 21 - (m >> 1)
    while (lo < hi) {
      let med = lo + ((hi - lo) >> 1)
      if (med <= 0 && lo >> 1 < med) med = lo >> 1
      else if (med >= 0 && hi >> 1 > med) med = hi >> 1
      const r = this.negamax(cLo, cHi, oLo, oHi, m, med, med + 1)
      if (r <= med) hi = r
      else lo = r
    }
    return lo
  }
}

/** Solves the position for the side to move. Throws if the game is already over. */
export function solve(state: FourState, opts: SolveOptions = {}): SolveResult {
  if (state.winner !== null || state.n >= 42) throw new Error('solve: the game is already over')
  const m = state.n
  const seat = m % 2
  const cLo = state.bb[seat * 2]!
  const cHi = state.bb[seat * 2 + 1]!
  const oLo = state.bb[(1 - seat) * 2]!
  const oHi = state.bb[(1 - seat) * 2 + 1]!
  const s = new Searcher(opts.ttBits ?? 22)
  if (opts.maxNodes !== undefined) s.maxNodes = opts.maxNodes
  if (opts.deadline !== undefined) s.deadline = opts.deadline
  for (let c = 0; c < COLS; c++) {
    s.h[c] = state.h[c]!
    for (let r = 0; r < state.h[c]!; r++) {
      const [bl, bh] = bitOf(c, r)
      const owner = (state.bb[0]! & bl) !== 0 || (state.bb[1]! & bh) !== 0 ? 0 : 1
      const [ml, mh] = bitOf(COLS - 1 - c, r)
      s.mir[owner * 2] = (s.mir[owner * 2]! | ml) >>> 0
      s.mir[owner * 2 + 1] = (s.mir[owner * 2 + 1]! | mh) >>> 0
    }
  }

  const playable: number[] = []
  const winning: number[] = []
  for (let c = 0; c < COLS; c++) {
    if (state.h[c]! >= ROWS) continue
    playable.push(c)
    const [bl, bh] = bitOf(c, state.h[c]!)
    if (hasFour((cLo | bl) >>> 0, (cHi | bh) >>> 0)) winning.push(c)
  }
  // Strong mode: an immediate win is the fastest win. Weak mode keeps searching so every column that keeps the win is listed.
  if (winning.length > 0 && !opts.weak) return { score: 21 - (m >> 1), bestMoves: winning, nodes: 0 }
  if (m === 41) return { score: opts.weak ? (winning.length > 0 ? 1 : 0) : 0, bestMoves: winning.length > 0 ? winning : playable, nodes: 0 }

  const score = opts.weak ? s.outcome(cLo, cHi, oLo, oHi, m) : s.exact(cLo, cHi, oLo, oHi, m)
  if (opts.weak && score < 0) return { score, bestMoves: playable, nodes: s.nodes } // every move loses
  const bestMoves: number[] = []
  for (const c of playable) {
    if (winning.includes(c)) {
      bestMoves.push(c) // wins on the spot: reaches any score the position can have
      continue
    }
    const [bl, bh] = bitOf(c, state.h[c]!)
    s.make(c, m)
    // the move reaches `score` exactly when the opponent's value is at most -score
    const r = s.negamax(oLo, oHi, (cLo | bl) >>> 0, (cHi | bh) >>> 0, m + 1, -score, -score + 1)
    s.unmake(c, m)
    if (r <= -score) bestMoves.push(c)
  }
  return { score, bestMoves, nodes: s.nodes }
}

