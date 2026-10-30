import type { GameCore, Result, Seat } from '../../types'
import type { GameId } from '../../product'
import { hashState } from '../../hash'
import { makeRng } from '../../rng'

/**
 * Cairn: the template game. A pile of stones, two players, take 1, 2 or 3 stones per turn,
 * and whoever takes the last stone wins. The seed sets the pile size (13 to 24), so across
 * seeds either seat can be the one with the forced win.
 *
 * It is the smallest complete GameCore: deterministic, seeded, no hidden information. Copy this
 * file when you add a game (docs/add-a-game.md). It is NOT one of the six product games: it has no
 * entry in PRODUCT.games and is not in the getCore() registry, so players never see it.
 */

export const MIN_TAKE = 1
export const MAX_TAKE = 3
export const MIN_PILE = 13
export const MAX_PILE = 24

export interface CairnState {
  /** Stones left in the pile. */
  pile: number
  /** Seat to act. Stays on the winner once the pile is empty. */
  turn: Seat
  /** Set when the pile reaches 0. */
  winner: Seat | null
}

/** A move is the number of stones to take, 1 to 3. */
export type CairnAction = number

export interface CairnObservation {
  pile: number
  seat: Seat
  /** True when the observer is the seat to act. */
  toMove: boolean
}

/**
 * The id is typed as GameId because GameCore requires it. A real product game adds its id to
 * GameId in packages/core/src/product.ts; the template deliberately does not, to stay out of the product.
 */
const ID = 'cairn' as GameId

export const cairnCore: GameCore<CairnState, CairnAction, CairnObservation> = {
  id: ID,
  version: 'cairn-1',
  init(seed) {
    return { pile: MIN_PILE + makeRng(seed).int(MAX_PILE - MIN_PILE + 1), turn: 0, winner: null }
  },
  toAct: (s) => (s.winner === null ? [s.turn] : []),
  legal(s, seat) {
    if (s.winner !== null || seat !== s.turn) return []
    const out: number[] = []
    for (let n = MIN_TAKE; n <= Math.min(MAX_TAKE, s.pile); n++) out.push(n)
    return out
  },
  step(s, actions) {
    if (s.winner !== null) throw new Error('cairn: the game is over')
    const other = (1 - s.turn) as Seat
    if (actions[other] !== null && actions[other] !== undefined) throw new Error('cairn: only seat ' + s.turn + ' may act')
    const take = actions[s.turn]
    if (take === null || take === undefined) throw new Error('cairn: missing action for seat ' + s.turn)
    if (!Number.isInteger(take) || take < MIN_TAKE || take > Math.min(MAX_TAKE, s.pile)) throw new Error('cairn: illegal take ' + take)
    const pile = s.pile - take
    return pile === 0 ? { pile, turn: s.turn, winner: s.turn } : { pile, turn: other, winner: null }
  },
  terminal: (s) => s.winner !== null,
  result(s): Result | null {
    if (s.winner === null) return null
    return { winner: s.winner, score: s.winner === 0 ? [1, 0] : [0, 1], reason: 'took the last stone' }
  },
  observe: (s, seat) => ({ pile: s.pile, seat, toMove: s.winner === null && s.turn === seat }),
  hash: (s) => hashState(s),
  encodeAction(a) {
    if (!Number.isInteger(a) || a < MIN_TAKE || a > MAX_TAKE) throw new Error('cairn: bad take ' + a)
    return a
  },
  decodeAction(n) {
    if (!Number.isInteger(n) || n < MIN_TAKE || n > MAX_TAKE) throw new Error('cairn: bad action code ' + n)
    return n
  },
}

/**
 * The perfect move: leave a multiple of four stones for the opponent. When the pile is already a
 * multiple of four the position is lost against perfect play, so take one and hope.
 */
export function optimalTake(pile: number): number {
  const r = pile % (MAX_TAKE + 1)
  return r === 0 ? MIN_TAKE : r
}

/** Factory form for the measurement harness, which builds a core from a module path (packages/agents/src/measure/harness.ts). */
export function createCairnCore() {
  return cairnCore
}
