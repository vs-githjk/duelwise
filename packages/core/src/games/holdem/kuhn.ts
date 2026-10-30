import type { Rng } from '../../types'
import type { CfrGame } from './mccfr'
import type { EnumGame } from './best-response'

// Kuhn poker: cards 0..2 (J, Q, K), ante 1, one bet of 1. Action 0 is pass (check or fold),
// action 1 is bet (bet or call). The value of the game to the first player is -1/18.

export interface KuhnState {
  cards: [number, number]
  /** Betting so far, e.g. "pb". */
  h: string
}

export const KUHN_VALUE = -1 / 18

const isTerm = (h: string): boolean => h === 'pp' || h === 'bp' || h === 'bb' || h === 'pbp' || h === 'pbb'

export const kuhn: CfrGame<KuhnState> & EnumGame<KuhnState> = {
  width: 2,
  sampleRoot(rng: Rng) {
    const a = rng.int(3)
    let b = rng.int(2)
    if (b >= a) b++
    return { cards: [a, b], h: '' }
  },
  roots() {
    const out: Array<{ p: number; state: KuhnState }> = []
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (a !== b) out.push({ p: 1 / 6, state: { cards: [a, b], h: '' } })
    return out
  },
  isTerminal: (s) => isTerm(s.h),
  utility(s, player) {
    const [c0, c1] = s.cards
    let u0: number
    switch (s.h) {
      case 'bp':
        u0 = 1
        break
      case 'pbp':
        u0 = -1
        break
      case 'pp':
        u0 = c0 > c1 ? 1 : -1
        break
      default:
        u0 = c0 > c1 ? 2 : -2
    }
    return player === 0 ? u0 : -u0
  },
  actor: (s) => (s.h.length % 2) as 0 | 1,
  actions: () => [0, 1],
  child: (s, a) => ({ cards: s.cards, h: s.h + (a === 0 ? 'p' : 'b') }),
  key: (s) => s.cards[s.h.length % 2]! + s.h,
}
