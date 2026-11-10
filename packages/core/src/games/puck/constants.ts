import type { Level } from '../../product'

export const PUCK_TPS = 60
export const SUBSTEPS = 4
export const GOALS_TO_WIN = 7
export const CAP_FRAMES = 21_600
export const HARD_CAP_FRAMES = 36_000
export const POSSESSION_FRAMES = 420
export const DEAD_FRAMES = 180
export const READY_FRAMES = 45
export const RULE_MALLET_SPEED = 6
export const PUCK_MAX_SPEED = 4.5
export const GRID = 1024
export const NO_INPUT = GRID * GRID

export interface MalletLimits {
  /** W/s. */
  speed: number
  /** W/s^2. */
  accel: number
  /** W, standard deviation of the target noise an agent adds (used by the env, not by the sim). */
  targetNoise: number
}

export const LEVEL_MALLET: Record<Level, MalletLimits> = {
  easy: { speed: 2.6, accel: 22, targetNoise: 0.06 },
  medium: { speed: 3.6, accel: 34, targetNoise: 0.035 },
  hard: { speed: 4.8, accel: 50, targetNoise: 0.018 },
  champion: { speed: 6.0, accel: 70, targetNoise: 0.008 },
}

/** Table geometry, world units (table is 1 wide, 2 long). */
export const TABLE_W = 1
export const TABLE_L = 2
export const PUCK_R = 0.04
export const MALLET_R = 0.065
export const GOAL_W = 0.34
export const POST_L = (TABLE_W - GOAL_W) / 2
export const POST_R = TABLE_W - POST_L
export const WALL_REST = 0.9
export const MALLET_REST = 0.85
/** Per-substep drag factor, about 0.985 per second over 240 substeps. */
export const DRAG_SUB = 0.999937
export const DT = 1 / (PUCK_TPS * SUBSTEPS)
/** Acceleration of a seat with no explicit limits (human finger, rule). */
export const DEFAULT_ACCEL = 120
export const DEAD_SPEED = 0.05
export const DEAD_STRIP = 0.3
/** A puck that stays within this of where the dead count began is dead even if it jitters faster than DEAD_SPEED. */
export const DEAD_DRIFT = 0.04
export const NEAR_MISS_X = 0.08
export const NEAR_MISS_SPEED = 1
export const MAX_HITS = 6

/** Event kinds, also the lastEvent kind. */
export const PUCK_EVENTS = { goal: 1, shot: 2, save: 3, post: 4, nearMiss: 5, foul: 6 } as const
export type PuckEventKind = (typeof PUCK_EVENTS)[keyof typeof PUCK_EVENTS]

export const PHASE = { READY: 0, LIVE: 1, OVER: 2 } as const
/** Why the match ended. */
export const END = { NONE: 0, GOALS: 1, TIME: 2, SUDDEN: 3, DRAW: 4 } as const
