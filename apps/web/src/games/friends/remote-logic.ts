import { Chess } from 'chess.js'
import type { FourObservation } from '@duelwise/core/src/games/four/core'
import { bitOf, hasFour, COLS, ROWS, type FourState } from '@duelwise/core/src/games/four/rules'
import type { SlackObs } from '@duelwise/core/src/games/slack/core'
import type { Seat } from '@duelwise/core/src/types'
import type { LastMove as ChessLast } from '../chess/useChessMatch'
import type { LastMove as FourLast } from '../four/useFourMatch'
import type { LastMove as SlackLast } from '../slack/match'

/** Pure rebuilds the remote pages draw from, kept free of React and UI so a test can import them alone. */

/** The move that turns one position into the next, found by playing each legal move on a throwaway board. Null when the pages missed more than one move (a reconnect). */
export function chessMoveBetween(prevFen: string, fen: string): { last: ChessLast; san: string } | null {
  try {
    const c = new Chess(prevFen)
    for (const m of c.moves({ verbose: true })) {
      const t = new Chess(prevFen)
      t.move(m.san)
      if (t.fen() === fen) return { last: { from: m.from, to: m.to }, san: m.san }
    }
  } catch {
    /* a fen the board refuses: draw without a highlight */
  }
  return null
}


/**
 * The board the page draws, rebuilt from one seat's observation: `cells` says 1 for that seat's stones and 2 for the other's, bottom row first.
 * Only the stones are rebuilt (a stone's seat, the column heights, the count, a four in a row), which is all the board reads.
 */
export function fourStateFromObs(obs: FourObservation): FourState {
  const bb: [number, number, number, number] = [0, 0, 0, 0]
  const h = new Array<number>(COLS).fill(0)
  let n = 0
  for (let c = 0; c < COLS; c++) {
    for (let row = 0; row < ROWS; row++) {
      const v = obs.cells[row * COLS + c]!
      if (v === 0) break
      const seat = v === 1 ? obs.seat : ((1 - obs.seat) as Seat)
      const [lo, hi] = bitOf(c, row)
      bb[seat * 2] = (bb[seat * 2]! | lo) >>> 0
      bb[seat * 2 + 1] = (bb[seat * 2 + 1]! | hi) >>> 0
      h[c] = row + 1
      n++
    }
  }
  const winner: Seat | null = hasFour(bb[0], bb[1]) ? 0 : hasFour(bb[2], bb[3]) ? 1 : null
  return { bb, h, n, winner }
}

/** The stone that appeared between two views of the same game, or null (first view, a reconnect that skipped moves, or a new game). */
export function newStone(prev: number[] | null, cells: number[], you: Seat): FourLast | null {
  if (!prev) return null
  let found: FourLast | null = null
  for (let i = 0; i < cells.length; i++) {
    if (prev[i] === 0 && cells[i] !== 0) {
      if (found) return null
      found = { col: i % COLS, row: Math.floor(i / COLS), seat: cells[i] === 1 ? you : ((1 - you) as Seat) }
    }
  }
  return found
}


/** The absolute board (1 is seat 0, 2 is seat 1) from one seat's observation (1 is that seat's discs, 2 the other's). */
export function absoluteCells(obs: SlackObs): number[] {
  return obs.cells.map((v) => (v === 0 ? 0 : v === 1 ? obs.seat + 1 : 2 - obs.seat))
}

/** What changed between two boards of one game: the disc placed and the discs that turned over. Null unless exactly one disc appeared. */
export function slackMoveBetween(prev: number[] | null, cells: number[]): SlackLast | null {
  if (!prev) return null
  let cell: number | null = null
  const flips: number[] = []
  for (let i = 0; i < cells.length; i++) {
    if (prev[i] === 0 && cells[i] !== 0) {
      if (cell !== null) return null
      cell = i
    } else if (prev[i] !== 0 && prev[i] !== cells[i]) flips.push(i)
  }
  return cell === null ? null : { seat: (cells[cell]! - 1) as Seat, cell, flips }
}

