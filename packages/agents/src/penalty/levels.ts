import type { Level } from '@duelwise/core/src/product'

/**
 * Equilibrium mix of the goal table in core.ts (GOAL_PER_MILLE), solved exactly on its support; a test recomputes both by fictitious
 * play within 0.01. The shooter's mix is by zone, top row first: only the four corners and the centre are in it, since five dives can
 * hold at most five zones level. The keeper's is by dive: left high, left low, stay, right high, right low. Goal value 0.688.
 */
export const EQ_SHOOTER: readonly number[] = [0.2525, 0, 0.2525, 0, 0.1736, 0, 0.1607, 0, 0.1607]
export const EQ_KEEPER: readonly number[] = [0.1716, 0.2671, 0.1227, 0.1716, 0.2671]

export type PenaltyLevelConfig =
  | { kind: 'pip'; /** Share of kicks and dives on the favourite; the rest go to its mirror image. */ favourite: number }
  | { kind: 'marlow'; /** Weight of the read; the rest is the equilibrium mix. */ read: number }
  | { kind: 'vesper'; read: number }
  | { kind: 'sable'; /** Best-response weight is min(1, weight * (1 - P(equilibrium))). */ weight: number }

/** Dials as first set in the sim (plan/bench/more-games-sim/pen9.ts, table t4). The proof is the dry ladder through the real harness (dry-ladder.ts): these agents differ from the sim's on Sable's opener and ties. Sable's weight is what makes it read a habit fast but stay near equilibrium when unsure. */
export const PENALTY_LEVELS: Record<Level, PenaltyLevelConfig> = {
  easy: { kind: 'pip', favourite: 0.75 },
  medium: { kind: 'marlow', read: 0.75 },
  hard: { kind: 'vesper', read: 0.75 },
  champion: { kind: 'sable', weight: 1.5 },
}
