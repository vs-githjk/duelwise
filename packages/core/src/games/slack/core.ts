import type { GameCore, Result, Seat } from '../../types'
import type { GameId } from '../../product'
import { hashState } from '../../hash'

/**
 * Slackwater: eight by eight, two colours of disc. A move places a disc so that it closes a line
 * of the other colour against one of your own, and every closed line flips. No luck anywhere in the
 * rules. A seat with no move must pass; the game ends the moment neither seat can move.
 *
 * Not yet in PRODUCT.games or the getCore() registry (groundwork only), so the id is cast like the
 * template game's. Action codes: 0..63 is row * 8 + col with row 0 at the top, 64 is pass.
 */
export const SIZE = 8
export const CELLS = 64
export const PASS = 64

export type SlackAction = number

export interface SlackState {
  /** 64 cells, index row * 8 + col: 0 empty, 1 seat 0 (moves first), 2 seat 1. */
  cells: number[]
  /** Seat to act. After a move it is always the other seat, who then passes if stuck. */
  turn: Seat
}

export interface SlackObs {
  /** 0 empty, 1 mine, 2 theirs. */
  cells: number[]
  seat: Seat
  toMove: boolean
  /** This seat's moves, [] when not to move. A forced pass shows as [PASS]. */
  legal: number[]
  /** Discs: mine, theirs. */
  discs: [number, number]
}

const ID = 'slack' as GameId

const DIRS: readonly (readonly [number, number])[] = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
]

/** Cells that placing a disc of value seatValue (1 or 2) on an empty cell would flip. [] if none or occupied. */
export function flipsFor(cells: number[], seatValue: 1 | 2, cell: number): number[] {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS || cells[cell] !== 0) return []
  const other = seatValue === 1 ? 2 : 1
  const r0 = Math.floor(cell / SIZE)
  const c0 = cell % SIZE
  const out: number[] = []
  for (const [dr, dc] of DIRS) {
    const line: number[] = []
    let r = r0 + dr
    let c = c0 + dc
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && cells[r * SIZE + c] === other) {
      line.push(r * SIZE + c)
      r += dr
      c += dc
    }
    if (line.length > 0 && r >= 0 && r < SIZE && c >= 0 && c < SIZE && cells[r * SIZE + c] === seatValue) out.push(...line)
  }
  return out
}

function placements(cells: number[], seat: Seat): number[] {
  const v = (seat + 1) as 1 | 2
  const out: number[] = []
  for (let i = 0; i < CELLS; i++) if (cells[i] === 0 && flipsFor(cells, v, i).length > 0) out.push(i)
  return out
}

function hasMove(cells: number[], seat: Seat): boolean {
  const v = (seat + 1) as 1 | 2
  for (let i = 0; i < CELLS; i++) if (cells[i] === 0 && flipsFor(cells, v, i).length > 0) return true
  return false
}

function isOver(s: SlackState): boolean {
  return !hasMove(s.cells, 0) && !hasMove(s.cells, 1)
}

function discCount(cells: number[]): [number, number] {
  let a = 0
  let b = 0
  for (const v of cells) {
    if (v === 1) a++
    else if (v === 2) b++
  }
  return [a, b]
}

function legalFor(s: SlackState, seat: Seat): number[] {
  if (seat !== s.turn) return []
  const moves = placements(s.cells, seat)
  if (moves.length > 0) return moves
  // No move: a pass is the only action, unless the other seat is stuck too (game over).
  return hasMove(s.cells, (1 - seat) as Seat) ? [PASS] : []
}

export const slackCore: GameCore<SlackState, SlackAction, SlackObs> = {
  id: ID,
  version: 'slack-1',
  // The rules hold no randomness, so the seed is ignored, as Four's is. Variety in measured matches
  // comes from an opening core in the agents package, and from agent noise read from the seed in play.
  init() {
    const cells = new Array<number>(CELLS).fill(0)
    cells[3 * SIZE + 3] = 2
    cells[4 * SIZE + 4] = 2
    cells[3 * SIZE + 4] = 1
    cells[4 * SIZE + 3] = 1
    return { cells, turn: 0 }
  },
  toAct: (s) => (isOver(s) ? [] : [s.turn]),
  legal: (s, seat) => legalFor(s, seat),
  step(s, actions) {
    const seat = s.turn
    const other = (1 - seat) as Seat
    if (actions[other] !== null && actions[other] !== undefined) throw new Error('slack: only seat ' + seat + ' may act')
    const a = actions[seat]
    if (a === null || a === undefined) throw new Error('slack: missing action for seat ' + seat)
    if (isOver(s)) throw new Error('slack: the game is over')
    if (!Number.isInteger(a) || a < 0 || a > PASS) throw new Error('slack: bad action ' + a)
    if (a === PASS) {
      if (hasMove(s.cells, seat)) throw new Error('slack: cannot pass with a move available')
      return { cells: s.cells.slice(), turn: other }
    }
    const flips = flipsFor(s.cells, (seat + 1) as 1 | 2, a)
    if (flips.length === 0) throw new Error('slack: illegal cell ' + a)
    const cells = s.cells.slice()
    const v = seat + 1
    cells[a] = v
    for (const f of flips) cells[f] = v
    return { cells, turn: other }
  },
  terminal: isOver,
  result(s): Result | null {
    if (!isOver(s)) return null
    const [a, b] = discCount(s.cells)
    if (a > b) return { winner: 0, score: [1, 0], reason: 'most discs' }
    if (b > a) return { winner: 1, score: [0, 1], reason: 'most discs' }
    return { winner: null, score: [0.5, 0.5], reason: 'level on discs' }
  },
  observe(s, seat) {
    const mine = seat + 1
    const cells = s.cells.map((v) => (v === 0 ? 0 : v === mine ? 1 : 2))
    const [a, b] = discCount(s.cells)
    return {
      cells,
      seat,
      toMove: !isOver(s) && s.turn === seat,
      legal: legalFor(s, seat),
      discs: seat === 0 ? [a, b] : [b, a],
    }
  },
  hash: (s) => hashState({ cells: s.cells, turn: s.turn }),
  encodeAction(a) {
    if (!Number.isInteger(a) || a < 0 || a > PASS) throw new Error('slack: bad action ' + a)
    return a
  },
  decodeAction(n) {
    if (!Number.isInteger(n) || n < 0 || n > PASS) throw new Error('slack: bad action code ' + n)
    return n
  },
}

export function createSlackCore(): typeof slackCore {
  return slackCore
}
