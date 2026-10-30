import type { GameCore, Result, Seat } from '../../types'
import { hashState } from '../../hash'
import {
  MATCH_HANDS,
  STACK,
  applyAction,
  initMatch,
  legalActions,
  raiseRange,
  type HandSummary,
  type HoldemAction,
  type HoldemState,
} from './match'

export type { HoldemAction, HoldemState } from './match'

export interface HoldemObservation {
  seat: Seat
  hand: number
  handsTotal: number
  /** Own hole cards only. */
  hole: number[]
  board: number[]
  street: 0 | 1 | 2 | 3
  bet: [number, number]
  total: [number, number]
  isButton: boolean
  toMove: boolean
  /** Legal raise-to range for the observer; 0 when the observer cannot raise now. */
  minRaiseTo: number
  maxRaiseTo: number
  net: [number, number]
  /** The previous hand; opponent cards appear only if it reached showdown. */
  last: HandSummary | null
}

/** Action codes: 0 fold, 1 call or check, 2 concede, 3 + t raise to t (t in 1..100). */
const RAISE_BASE = 3

export const holdemCore: GameCore<HoldemState, HoldemAction, HoldemObservation> = {
  id: 'holdem',
  version: 'holdem-1',
  init: (seed, opts) => initMatch(seed, opts as { deck?: number[] } | undefined),
  toAct: (s) => (s.over ? [] : [s.actor]),
  legal: (s, seat) => legalActions(s, seat),
  step(s, actions) {
    const other = (1 - s.actor) as Seat
    if (actions[other] !== null && actions[other] !== undefined) throw new Error('holdem: only seat ' + s.actor + ' may act')
    const a = actions[s.actor]
    if (a === null || a === undefined) throw new Error('holdem: missing action for seat ' + s.actor)
    return applyAction(s, s.actor, a)
  },
  terminal: (s) => s.over !== null,
  result(s): Result | null {
    if (!s.over) return null
    const w = s.over.winner
    return { winner: w, score: w === null ? [0.5, 0.5] : w === 0 ? [1, 0] : [0, 1], reason: s.over.reason }
  },
  observe(s, seat) {
    const { minTo, maxTo } = raiseRange(s, seat)
    const can = minTo <= maxTo
    return {
      seat,
      hand: s.hand,
      handsTotal: MATCH_HANDS,
      hole: s.hole[seat].slice(),
      board: s.board.slice(),
      street: s.street,
      bet: [s.bet[0], s.bet[1]],
      total: [s.total[0], s.total[1]],
      isButton: s.button === seat,
      toMove: !s.over && s.actor === seat,
      minRaiseTo: can ? minTo : 0,
      maxRaiseTo: can ? maxTo : 0,
      net: [s.net[0], s.net[1]],
      last: s.last
        ? {
            ...s.last,
            board: s.last.board.slice(),
            hole: s.last.hole ? [s.last.hole[0].slice(), s.last.hole[1].slice()] : null,
          }
        : null,
    }
  },
  hash: (s) => hashState(s),
  encodeAction(a) {
    switch (a.type) {
      case 'fold':
        return 0
      case 'call':
        return 1
      case 'concede':
        return 2
      case 'raise':
        if (!Number.isInteger(a.to) || a.to < 1 || a.to > STACK) throw new Error('holdem: bad raise ' + a.to)
        return RAISE_BASE + a.to
      default:
        throw new Error('holdem: bad action')
    }
  },
  decodeAction(n) {
    if (n === 0) return { type: 'fold' }
    if (n === 1) return { type: 'call' }
    if (n === 2) return { type: 'concede' }
    if (Number.isInteger(n) && n > RAISE_BASE && n <= RAISE_BASE + STACK) return { type: 'raise', to: n - RAISE_BASE }
    throw new Error('holdem: bad action code ' + n)
  },
}
