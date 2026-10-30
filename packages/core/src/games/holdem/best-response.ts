import type { CfrGame } from './mccfr'

// Exact best response and exploitability for games small enough to enumerate every deal (Kuhn,
// Leduc). A strategy is a function from an infoset key to action probabilities (width entries).

export interface EnumGame<S> {
  roots(): Array<{ p: number; state: S }>
}

export type StrategyFn = (key: string, mask: number) => Float64Array

interface Weighted<S> {
  s: S
  w: number
}

/** Expected payoff to `br` when it plays a best response and the opponent follows `sigma`. */
export function bestResponseValue<S>(game: CfrGame<S> & EnumGame<S>, sigma: StrategyFn, br: 0 | 1): number {
  const rec = (set: Weighted<S>[]): number => {
    if (set.length === 0) return 0
    if (game.isTerminal(set[0]!.s)) {
      let v = 0
      for (const n of set) v += n.w * game.utility(n.s, br)
      return v
    }
    if (game.actor(set[0]!.s) === br) {
      const groups = new Map<string, Weighted<S>[]>()
      for (const n of set) {
        const k = game.key(n.s)
        const g = groups.get(k)
        if (g) g.push(n)
        else groups.set(k, [n])
      }
      let total = 0
      for (const g of groups.values()) {
        let best = -Infinity
        for (const a of game.actions(g[0]!.s)) {
          const v = rec(g.map((n) => ({ s: game.child(n.s, a), w: n.w })))
          if (v > best) best = v
        }
        total += best
      }
      return total
    }
    const acts = game.actions(set[0]!.s)
    let total = 0
    for (const a of acts) {
      const next: Weighted<S>[] = []
      for (const n of set) {
        const mask = acts.reduce((m, x) => m | (1 << x), 0)
        const p = sigma(game.key(n.s), mask)[a]!
        if (p > 0) next.push({ s: game.child(n.s, a), w: n.w * p })
      }
      total += rec(next)
    }
    return total
  }
  return rec(game.roots().map((r) => ({ s: r.state, w: r.p })))
}

/** Expected payoff to player 0 when both seats follow `sigma`. */
export function gameValue<S>(game: CfrGame<S> & EnumGame<S>, sigma: StrategyFn): number {
  const rec = (s: S): number => {
    if (game.isTerminal(s)) return game.utility(s, 0)
    const acts = game.actions(s)
    const mask = acts.reduce((m, x) => m | (1 << x), 0)
    const p = sigma(game.key(s), mask)
    let v = 0
    for (const a of acts) if (p[a]! > 0) v += p[a]! * rec(game.child(s, a))
    return v
  }
  let total = 0
  for (const r of game.roots()) total += r.p * rec(r.state)
  return total
}

/**
 * Exploitability in chips per game: the average of what each seat's best response wins against
 * the other seat's strategy. It is zero at an equilibrium of a zero-sum game.
 */
export function exploitability<S>(game: CfrGame<S> & EnumGame<S>, sigma: StrategyFn): number {
  return (bestResponseValue(game, sigma, 0) + bestResponseValue(game, sigma, 1)) / 2
}
