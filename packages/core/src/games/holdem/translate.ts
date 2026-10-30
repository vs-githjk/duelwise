import { CALL, abstractActions, raiseFraction, type AbstractAction, type BetSpot } from './abstraction'

// Pseudo-harmonic action translation (Ganzfried and Sandholm 2013). A raise that is not one of
// the abstract sizes is mapped to one of the two abstract sizes that bracket it, at random, with
// probability chosen so the mapping is stable under small changes. Sizes are fractions of the
// pot after calling; "call" counts as size 0.

/** Probability of choosing the smaller size `a` for an observed size `x` with a <= x <= b. */
export function harmonicProbLower(x: number, a: number, b: number): number {
  if (x <= a) return 1
  if (x >= b) return 0
  return ((b - x) * (1 + a)) / ((b - a) * (1 + x))
}

/** One way the observed raise can be read by a table that knows only the abstract sizes, and how likely it is. */
export interface TranslationOutcome {
  action: AbstractAction
  p: number
}

/**
 * Every abstract option an observed raise-to amount can translate to, with its probability. Bets that are
 * on the tree map to themselves with probability 1, sizes beyond the largest option map to it, and an
 * off-tree size between two options splits between them by the pseudo-harmonic rule (smaller option first).
 */
export function translationOutcomes(spot: BetSpot, observedTo: number): TranslationOutcome[] {
  const options = abstractActions(spot)
    .filter((a) => a.id !== 0)
    .map((a) => ({ a, size: a.id === CALL ? 0 : raiseFraction(spot, a.to) }))
    .sort((p, q) => p.a.to - q.a.to)
  const x = raiseFraction(spot, observedTo)
  const exact = options.find((o) => (o.a.id === CALL ? observedTo <= o.a.to : observedTo === o.a.to))
  if (exact) return [{ action: exact.a, p: 1 }]
  const last = options[options.length - 1]!
  if (observedTo >= last.a.to) return [{ action: last.a, p: 1 }]
  let k = 0
  while (k + 1 < options.length && options[k + 1]!.a.to <= observedTo) k++
  const lo = options[k]!
  const hi = options[k + 1]!
  const pLo = harmonicProbLower(x, lo.size, hi.size)
  return [
    { action: lo.a, p: pLo },
    { action: hi.a, p: 1 - pLo },
  ]
}

/**
 * Maps an observed raise-to amount to an abstract option. `spot` is the raiser's spot before the
 * raise; `u` is a uniform random number in [0, 1). Bets that are on the tree map to themselves,
 * and sizes beyond the largest option map to it.
 */
export function translateRaise(spot: BetSpot, observedTo: number, u: number): AbstractAction {
  const outcomes = translationOutcomes(spot, observedTo)
  if (outcomes.length === 1) return outcomes[0]!.action
  return u < outcomes[0]!.p ? outcomes[0]!.action : outcomes[1]!.action
}
