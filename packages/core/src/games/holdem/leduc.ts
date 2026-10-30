import type { Rng } from '../../types'
import type { CfrGame } from './mccfr'
import type { EnumGame } from './best-response'

// Leduc poker: six cards (ranks J, Q, K, two suits each), ante 1, two betting rounds with raise
// sizes 2 then 4, at most two raises per round. Actions: 0 fold, 1 check or call, 2 bet or raise.

export interface LeducState {
  priv: [number, number]
  board: number
  /** Betting so far; one letter per action (f, c, r), rounds joined by "|". */
  h: string
  round: 0 | 1
  contrib: [number, number]
  /** Chips each seat has put in during this round. */
  rb: [number, number]
  acted: number
  raises: number
  actor: 0 | 1
  folded: 0 | 1 | null
  showdown: boolean
}

const RAISE_SIZE = [2, 4]
const MAX_RAISES = 2
const rank = (c: number): number => c >> 1

function root(priv: [number, number], board: number): LeducState {
  return { priv, board, h: '', round: 0, contrib: [1, 1], rb: [0, 0], acted: 0, raises: 0, actor: 0, folded: null, showdown: false }
}

function legal(s: LeducState): number[] {
  const out: number[] = []
  if (Math.max(s.rb[0], s.rb[1]) > s.rb[s.actor]) out.push(0)
  out.push(1)
  if (s.raises < MAX_RAISES) out.push(2)
  return out
}

export const leduc: CfrGame<LeducState> & EnumGame<LeducState> = {
  width: 3,
  sampleRoot(rng: Rng) {
    const deck = [0, 1, 2, 3, 4, 5]
    for (let i = 5; i > 0; i--) {
      const j = rng.int(i + 1)
      const t = deck[i]!
      deck[i] = deck[j]!
      deck[j] = t
    }
    return root([deck[0]!, deck[1]!], deck[2]!)
  },
  roots() {
    const out: Array<{ p: number; state: LeducState }> = []
    for (let a = 0; a < 6; a++)
      for (let b = 0; b < 6; b++)
        for (let c = 0; c < 6; c++) if (a !== b && a !== c && b !== c) out.push({ p: 1 / 120, state: root([a, b], c) })
    return out
  },
  isTerminal: (s) => s.folded !== null || s.showdown,
  utility(s, player) {
    const other = (1 - player) as 0 | 1
    if (s.folded !== null) return s.folded === player ? -s.contrib[player] : s.contrib[other]
    const score = (p: 0 | 1): number => (rank(s.priv[p]) === rank(s.board) ? 100 : 0) + rank(s.priv[p])
    const a = score(player)
    const b = score(other)
    return a === b ? 0 : a > b ? s.contrib[other] : -s.contrib[player]
  },
  actor: (s) => s.actor,
  actions: legal,
  child(s, a) {
    const me = s.actor
    const rb: [number, number] = [s.rb[0], s.rb[1]]
    const contrib: [number, number] = [s.contrib[0], s.contrib[1]]
    const top = Math.max(rb[0], rb[1])
    if (a === 0) return { ...s, h: s.h + 'f', folded: me }
    if (a === 1) {
      contrib[me] += top - rb[me]
      rb[me] = top
      const acted = s.acted + 1
      if (acted >= 2 && rb[0] === rb[1]) {
        if (s.round === 1) return { ...s, h: s.h + 'c', contrib, rb, acted, showdown: true }
        return { ...s, h: s.h + 'c|', round: 1, contrib, rb: [0, 0], acted: 0, raises: 0, actor: 0 }
      }
      return { ...s, h: s.h + 'c', contrib, rb, acted, actor: (1 - me) as 0 | 1 }
    }
    const to = top + RAISE_SIZE[s.round]!
    contrib[me] += to - rb[me]
    rb[me] = to
    return { ...s, h: s.h + 'r', contrib, rb, acted: s.acted + 1, raises: s.raises + 1, actor: (1 - me) as 0 | 1 }
  },
  key: (s) => rank(s.priv[s.actor]) + (s.round === 1 ? '/' + rank(s.board) : '') + ':' + s.h,
}
