import type { GameCore, Result, Seat } from '../../types'
import { hashState } from '../../hash'
import { COLS, ROWS, CELLS, drop, emptyState, isFull, isLegalColumn, seatToMove, stoneAt, type FourState } from './rules'

export type FourAction = number

export interface FourObservation {
  /** 42 cells, index row * 7 + col, row 0 at the bottom: 0 empty, 1 observer's stone, 2 opponent's. */
  cells: number[]
  seat: Seat
  /** True when the observer is the seat to act. */
  toMove: boolean
}

export const fourCore: GameCore<FourState, FourAction, FourObservation> = {
  id: 'four',
  version: 'four-1',
  init: () => emptyState(),
  toAct: (s) => (s.winner === null && !isFull(s) ? [seatToMove(s)] : []),
  legal(s, seat) {
    if (s.winner !== null || isFull(s) || seat !== seatToMove(s)) return []
    const out: number[] = []
    for (let c = 0; c < COLS; c++) if (isLegalColumn(s, c)) out.push(c)
    return out
  },
  step(s, actions) {
    const seat = seatToMove(s)
    const other = (1 - seat) as Seat
    if (actions[other] !== null && actions[other] !== undefined) throw new Error('four: only seat ' + seat + ' may act')
    const a = actions[seat]
    if (a === null || a === undefined) throw new Error('four: missing action for seat ' + seat)
    return drop(s, a)
  },
  terminal: (s) => s.winner !== null || isFull(s),
  result(s): Result | null {
    if (s.winner !== null) {
      return { winner: s.winner, score: s.winner === 0 ? [1, 0] : [0, 1], reason: 'four in a row' }
    }
    if (isFull(s)) return { winner: null, score: [0.5, 0.5], reason: 'board full' }
    return null
  },
  observe(s, seat) {
    const cells = new Array<number>(CELLS).fill(0)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = stoneAt(s, c, r)
        cells[r * COLS + c] = v === 0 ? 0 : v - 1 === seat ? 1 : 2
      }
    }
    return { cells, seat, toMove: s.winner === null && !isFull(s) && seatToMove(s) === seat }
  },
  hash: (s) => hashState({ bb: s.bb, n: s.n }),
  encodeAction(a) {
    if (!Number.isInteger(a) || a < 0 || a >= COLS) throw new Error('four: bad column ' + a)
    return a
  },
  decodeAction(n) {
    if (!Number.isInteger(n) || n < 0 || n >= COLS) throw new Error('four: bad action code ' + n)
    return n
  },
}
