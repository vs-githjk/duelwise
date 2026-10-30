import type { GameId, Level } from '@duelwise/core/src/product'

export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']

export function isLevel(x: unknown): x is Level {
  return typeof x === 'string' && (LEVELS as readonly string[]).includes(x)
}

export interface LevelPair {
  lower: Level
  upper: Level
}

/** Pairs of neighbouring levels in the given order; the list must be consecutive levels. */
export function adjacentPairs(levels: readonly Level[]): LevelPair[] {
  const out: LevelPair[] = []
  for (let i = 0; i + 1 < levels.length; i++) {
    const lower = levels[i]!
    const upper = levels[i + 1]!
    if (LEVELS.indexOf(upper) !== LEVELS.indexOf(lower) + 1) throw new Error(`adjacentPairs: ${lower} and ${upper} are not neighbouring levels`)
    out.push({ lower, upper })
  }
  return out
}

export interface PairBudget {
  maxGames: number
  /** Game counts at which a ladder may stop early (99% lower bound above 50%). */
  looks: number[]
}

/** At most 400 games per pair (200 for chess), with interim looks at 100 and 200 (chess 50 and 100). */
export function pairBudget(game: GameId): PairBudget {
  return game === 'chess' ? { maxGames: 200, looks: [50, 100] } : { maxGames: 400, looks: [100, 200] }
}
