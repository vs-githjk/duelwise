import type { Level } from '@duelwise/core/src/product'

/**
 * Equilibrium mix of the goal table in core.ts (GOAL_PER_MILLE), found by fictitious play; a test recomputes both within 0.01.
 * Four decimals on purpose: left and right differ by 0.0004, and with no history Sable's best response to its prior is decided by that gap (as in the sim), so rounding to three decimals would flip its opening side.
 * [Left, Middle, Right] for the shooter and for the keeper's dive.
 */
export const EQ_SHOOTER: readonly [number, number, number] = [0.3156, 0.3692, 0.3152]
export const EQ_KEEPER: readonly [number, number, number] = [0.4241, 0.1538, 0.4221]

export type PenaltyLevelConfig =
  | { kind: 'pip'; /** Share of kicks and dives on the favourite side; the rest go to the other side, never the middle. */ favourite: number }
  | { kind: 'marlow'; /** Weight of the read; the rest is the equilibrium mix. */ read: number }
  | { kind: 'vesper'; read: number }
  | { kind: 'sable'; /** Best-response weight is min(1, weight * (1 - P(equilibrium))). */ weight: number }

/** Same numbers as the dry-ladder sim (plan/bench/more-games-sim/pen.ts). Sable's weight is what makes it read a habit fast but stay near equilibrium when unsure. */
export const PENALTY_LEVELS: Record<Level, PenaltyLevelConfig> = {
  easy: { kind: 'pip', favourite: 0.75 },
  medium: { kind: 'marlow', read: 0.75 },
  hard: { kind: 'vesper', read: 0.75 },
  champion: { kind: 'sable', weight: 1.5 },
}
