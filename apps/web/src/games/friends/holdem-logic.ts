import type { HoldemObservation, HoldemState } from '@duelwise/core/src/games/holdem/core'
import type { HandSummary } from '@duelwise/core/src/games/holdem/match'
import type { Seat } from '@duelwise/core/src/types'
import { fullHandName } from '../holdem/strength'


/**
 * Hold'em tables are drawn from the point of view of "the human is seat 0" (BetControls, Table, the hand words). A remote page sits in
 * either game seat, so everything it draws is turned around here: index 0 is always the person looking, index 1 the friend.
 */
const flip2 = <T,>(pair: readonly [T, T], you: Seat): [T, T] => (you === 0 ? [pair[0], pair[1]] : [pair[1], pair[0]])

/** The observation with the viewer as seat 0: bets, totals and chips swapped when the viewer sits in game seat 1. */
export function holdemMineFirst(obs: HoldemObservation): HoldemObservation {
  return { ...obs, seat: 0, bet: flip2(obs.bet, obs.seat), total: flip2(obs.total, obs.seat), net: flip2(obs.net, obs.seat), last: obs.last ? holdemSideSummary(obs.last, obs.seat) : null }
}

/** A finished hand from the viewer's side: winner, chip change and hands with the viewer as seat 0. A folded hand still has no cards. */
export function holdemSideSummary(h: HandSummary, you: Seat): HandSummary {
  if (you === 0) return h
  return { ...h, winner: h.winner === null ? null : ((1 - h.winner) as Seat), delta: -h.delta, hole: h.hole ? [h.hole[1]!, h.hole[0]!] : null }
}

/** The table's state from one observation: my hole cards in the human slot, the friend's slot empty (the page never held them). */
export function holdemTableState(obs: HoldemObservation): HoldemState {
  const m = holdemMineFirst(obs)
  return {
    seed: 0,
    hand: m.hand,
    button: m.isButton ? 0 : 1,
    hole: [m.hole.slice(), []],
    board: m.board.slice(),
    deck: [],
    street: m.street,
    bet: [m.bet[0], m.bet[1]],
    total: [m.total[0], m.total[1]],
    acted: [false, false],
    actor: m.toMove ? 0 : 1,
    minRaise: 0,
    canRaise: [true, true],
    net: [m.net[0], m.net[1]],
    last: m.last,
    over: null,
  }
}

/**
 * What the table shows for a moment after a hand: the summary the room sent (already mine-first via `holdemSideSummary`) and the cards I held,
 * remembered by the page from before the hand ended. The pot split follows from the chip change: the loser put in what they lost, the winner the rest.
 */
export function holdemReveal(last: HandSummary, you: Seat, myHole: number[], friend: string, stage: 'show' | 'push') {
  const h = holdemSideSummary(last, you)
  const lost = Math.abs(h.delta)
  const total: [number, number] = h.winner === null ? [h.pot / 2, h.pot / 2] : h.winner === 0 ? [h.pot - lost, lost] : [lost, h.pot - lost]
  const won = lost
  const best = h.showdown && h.hole ? fullHandName(h.hole[h.winner ?? 0]!, h.board) : ''
  const headline =
    h.winner === null
      ? best
        ? `Split pot, ${h.pot / 2} each, both have ${best}`
        : `Split pot, ${h.pot / 2} each`
      : h.winner === 0
        ? h.showdown
          ? `You win ${won} at showdown with ${best}`
          : `You win ${won}, ${friend} folds`
        : h.showdown
          ? `${friend} wins ${won} at showdown with ${best}`
          : `${friend} wins ${won}, you fold`
  return { summary: h, stage, hole: h.showdown && h.hole ? h.hole[0]! : myHole, board: h.board, total, headline }
}
