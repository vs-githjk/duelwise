import type { Level } from '@duelwise/core/src/product'

/**
 * Equilibrium mix of the goal table in core.ts (GOAL_PER_MILLE), solved exactly on its support; a test recomputes both by fictitious
 * play within 0.01. The shooter's mix is by zone, top row first: only the four corners and the centre are in it, since five dives can
 * hold at most five zones level. The keeper's is by dive: left high, left low, stay, right high, right low. Goal value 0.688.
 */
export const EQ_SHOOTER: readonly number[] = [0.2525, 0, 0.2525, 0, 0.1736, 0, 0.1607, 0, 0.1607]
export const EQ_KEEPER: readonly number[] = [0.1716, 0.2671, 0.1227, 0.1716, 0.2671]

export type PenaltyLevelConfig =
  | { kind: 'pip' }
  | { kind: 'marlow'; /** Weight of the read as keeper; the rest is the equilibrium mix. */ read: number; /** Weight of the away-from-the-dives pick as kicker. */ kickRead: number }
  | { kind: 'vesper'; read: number; /** Weight of the corner swap as kicker. */ kickRead: number }
  | { kind: 'sable'; /** Best-response weight is min(cap, weight * (1 - P(equilibrium))). */ weight: number; /** The most it ever commits to its best response, so it never plays a pure pick on a guess. */ cap: number }

/** Dials as first set in the sim (plan/bench/more-games-sim/pen9.ts, table t4). The proof is the dry ladder through the real harness (dry-ladder.ts): these agents differ from the sim's on Sable's opener and ties. Sable's weight is what makes it read a habit fast but stay near equilibrium when unsure. */
export const PENALTY_LEVELS: Record<Level, PenaltyLevelConfig> = {
  easy: { kind: 'pip' },
  medium: { kind: 'marlow', read: 0.6, kickRead: 0.3 },
  hard: { kind: 'vesper', read: 0.75, kickRead: 0.4 },
  champion: { kind: 'sable', weight: 1, cap: 0.8 },
}

/**
 * Pip's mix. Graded predictability (owner, Nov 3): Pip a little predictable, Marlow less, Vesper less again, Sable least. Pip's
 * old mix was a favourite and its mirror only (75/25), which read as a four-corner loop; it now blends that with a wide mix, so a
 * habit shows but the middle zones and the stay turn up too. Pip never reads the match.
 */
export const PIP_HABIT_SHARE = 0.5
/** Wide mix, shooter, by zone, as relative weights rescaled to 1: favourite corner, its mirror, the two other corners (the bottom ones score most), the centre, a little on the four edge zones. */
export const PIP_SHOOTER = { favourite: 1, mirror: 0.63, topCorner: 0.2, bottomCorner: 0.34, centre: 0.35, edge: 0.06 } as const
/** Wide mix, keeper, by dive, as shares: favourite side dive, its mirror, the two other side dives, the stay (fewest goals against a player with no habit). */
export const PIP_KEEPER = { favourite: 0.22, mirror: 0.16, otherSide: 0.11, stay: 0.4 } as const

/** Vesper's swap as kicker, as shares of the swap part (they sum to 1): the corner across the goal in the same row, across in the other row, the other row on the same side, and a repeat. Loose on purpose, so no single kick can be named. */
export const VESPER_SWAP = { across: 0.5, acrossOtherRow: 0.25, sameSideOtherRow: 0.15, repeat: 0.1 } as const
