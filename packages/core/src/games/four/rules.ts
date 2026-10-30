import type { Seat } from '../../types'

// Board: 7 columns x 6 rows. Each column owns 7 bits (6 cells plus an always-empty sentinel
// bit on top), so bit index = col * 7 + row with row 0 at the bottom. 49 bits do not fit one
// 32-bit word, so every bitboard is a (lo, hi) pair of unsigned 32-bit halves. The sentinel
// row stops lines from wrapping into the next column when shifting.

export const COLS = 7
export const ROWS = 6
export const CELLS = 42
const STRIDE = 7

export interface FourState {
  /** [seat 0 lo, seat 0 hi, seat 1 lo, seat 1 hi]. */
  bb: [number, number, number, number]
  /** Stones per column. */
  h: number[]
  /** Stones played; seat n % 2 is to move. */
  n: number
  winner: Seat | null
}

export const shlLo = (lo: number, k: number): number => (lo << k) >>> 0
export const shlHi = (lo: number, hi: number, k: number): number => ((hi << k) | (lo >>> (32 - k))) >>> 0
export const shrLo = (lo: number, hi: number, k: number): number => ((lo >>> k) | (hi << (32 - k))) >>> 0
export const shrHi = (hi: number, k: number): number => hi >>> k

export function bitOf(col: number, row: number): [number, number] {
  const i = col * STRIDE + row
  return i < 32 ? [(1 << i) >>> 0, 0] : [0, (1 << (i - 32)) >>> 0]
}

let bm0 = 0
let bm1 = 0
for (let c = 0; c < COLS; c++) {
  for (let r = 0; r < ROWS; r++) {
    const [l, h] = bitOf(c, r)
    bm0 = (bm0 | l) >>> 0
    bm1 = (bm1 | h) >>> 0
  }
}
export const BOARD_LO = bm0
export const BOARD_HI = bm1

const DIRS = [1, 6, 7, 8] as const

/** True when the (lo, hi) bitboard holds four in a row in any direction. */
export function hasFour(lo: number, hi: number): boolean {
  for (let i = 0; i < 4; i++) {
    const d = DIRS[i]!
    const mLo = lo & shrLo(lo, hi, d)
    const mHi = hi & shrHi(hi, d)
    if ((mLo & shrLo(mLo, mHi, 2 * d)) | (mHi & shrHi(mHi, 2 * d))) return true
  }
  return false
}

export let winLo = 0
export let winHi = 0

/**
 * Cells that would complete a four for this bitboard (occupied cells included; callers mask
 * with the free cells). Result lands in winLo / winHi.
 */
export function computeWinCells(lo: number, hi: number): void {
  let rl = 0
  let rh = 0
  for (let i = 0; i < 4; i++) {
    const d = DIRS[i]!
    const l1l = shlLo(lo, d)
    const l1h = shlHi(lo, hi, d)
    const l2l = shlLo(lo, 2 * d)
    const l2h = shlHi(lo, hi, 2 * d)
    const l3l = shlLo(lo, 3 * d)
    const l3h = shlHi(lo, hi, 3 * d)
    const r1l = shrLo(lo, hi, d)
    const r1h = shrHi(hi, d)
    const r2l = shrLo(lo, hi, 2 * d)
    const r2h = shrHi(hi, 2 * d)
    const r3l = shrLo(lo, hi, 3 * d)
    const r3h = shrHi(hi, 3 * d)
    rl |= (l1l & l2l & l3l) | (l1l & l2l & r1l) | (l1l & r1l & r2l) | (r1l & r2l & r3l)
    rh |= (l1h & l2h & l3h) | (l1h & l2h & r1h) | (l1h & r1h & r2h) | (r1h & r2h & r3h)
  }
  winLo = (rl & BOARD_LO) >>> 0
  winHi = (rh & BOARD_HI) >>> 0
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

export function emptyState(): FourState {
  return { bb: [0, 0, 0, 0], h: [0, 0, 0, 0, 0, 0, 0], n: 0, winner: null }
}

export function seatToMove(s: FourState): Seat {
  return (s.n % 2) as Seat
}

export function isFull(s: FourState): boolean {
  return s.n >= CELLS
}

export function isLegalColumn(s: FourState, col: unknown): col is number {
  return typeof col === 'number' && Number.isInteger(col) && col >= 0 && col < COLS && s.h[col]! < ROWS
}

/** Drops a stone for the seat to move. Throws on an illegal column or a finished game. */
export function drop(s: FourState, col: unknown): FourState {
  if (s.winner !== null || isFull(s)) throw new Error('four: the game is over')
  if (!isLegalColumn(s, col)) throw new Error('four: illegal column ' + String(col))
  const seat = seatToMove(s)
  const [bl, bh] = bitOf(col, s.h[col]!)
  const bb: [number, number, number, number] = [s.bb[0], s.bb[1], s.bb[2], s.bb[3]]
  bb[seat * 2] = (bb[seat * 2]! | bl) >>> 0
  bb[seat * 2 + 1] = (bb[seat * 2 + 1]! | bh) >>> 0
  const h = s.h.slice()
  h[col] = h[col]! + 1
  const won = hasFour(bb[seat * 2]!, bb[seat * 2 + 1]!)
  return { bb, h, n: s.n + 1, winner: won ? seat : null }
}

/** Builds a position by playing columns from the empty board. Throws on an illegal move. */
export function fourFromMoves(cols: readonly number[]): FourState {
  let s = emptyState()
  for (const c of cols) s = drop(s, c)
  return s
}

/** Stone at (col, row): 0 empty, 1 seat 0, 2 seat 1. */
export function stoneAt(s: FourState, col: number, row: number): 0 | 1 | 2 {
  if (row >= s.h[col]!) return 0
  const i = col * STRIDE + row
  const word = (seat: number) => (i < 32 ? (s.bb[seat * 2]! >>> i) & 1 : (s.bb[seat * 2 + 1]! >>> (i - 32)) & 1)
  return word(0) ? 1 : 2
}
