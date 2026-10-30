import type { Rng, Seat } from '../../types'
import { shuffled } from './cards'
import { ACTION_WIDTH, CALL, FOLD, abstractActions, infoKey, type Abstraction, type AbstractAction, type BetSpot } from './abstraction'
import { applyAction, initMatch, raiseRange, type HoldemAction, type HoldemState } from './match'
import type { CfrGame } from './mccfr'

// One hand of heads-up hold'em on the real game core, seen through the abstraction. Chance is
// sampled once per iteration (a shuffled deck), the first hand of a match is played, and the
// payoff is the chips seat 0 won on that hand (seat 0 is the button).

export interface HoldemNode {
  s: HoldemState
  /** Lazily computed bucket per (seat, street) for this deal. */
  buckets: Int16Array
}

export function spotOf(s: HoldemState, seat: Seat): BetSpot {
  const opp = (1 - seat) as Seat
  const { minTo, maxTo } = raiseRange(s, seat)
  return { bet: s.bet[seat], oppBet: s.bet[opp], total: s.total[seat], oppTotal: s.total[opp], minTo, maxTo }
}

function toReal(a: AbstractAction): HoldemAction {
  if (a.id === FOLD) return { type: 'fold' }
  if (a.id === CALL) return { type: 'call' }
  return { type: 'raise', to: a.to }
}

export function holdemGame(abs: Abstraction): CfrGame<HoldemNode> {
  const bucketOf = (n: HoldemNode, seat: Seat): number => {
    const street = n.s.street
    const slot = seat * 4 + street
    let b = n.buckets[slot]!
    if (b < 0) {
      b = abs.bucket(street, n.s.hole[seat], n.s.board)
      n.buckets[slot] = b
    }
    return b
  }
  const optionsCache = new WeakMap<HoldemState, AbstractAction[]>()
  const options = (n: HoldemNode): AbstractAction[] => {
    let o = optionsCache.get(n.s)
    if (!o) {
      o = abstractActions(spotOf(n.s, n.s.actor))
      optionsCache.set(n.s, o)
    }
    return o
  }
  return {
    width: ACTION_WIDTH,
    sampleRoot(rng: Rng) {
      const buckets = new Int16Array(8).fill(-1)
      return { s: initMatch(0, { deck: shuffled(rng) }), buckets }
    },
    isTerminal: (n) => n.s.hand > 0 || n.s.over !== null,
    utility: (n, player) => (player === 0 ? n.s.net[0] : n.s.net[1]),
    actor: (n) => n.s.actor,
    actions: (n) => options(n).map((a) => a.id),
    child(n, id) {
      const a = options(n).find((x) => x.id === id)
      if (!a) throw new Error('holdem game: action ' + id + ' not available')
      return { s: applyAction(n.s, n.s.actor, toReal(a)), buckets: n.buckets }
    },
    key(n) {
      const seat = n.s.actor
      const opp = (1 - seat) as Seat
      return infoKey({
        street: n.s.street,
        bucket: bucketOf(n, seat),
        isButton: n.s.button === seat,
        prior: n.s.total[seat] - n.s.bet[seat],
        bet: n.s.bet[seat],
        oppBet: n.s.bet[opp],
      })
    },
  }
}
