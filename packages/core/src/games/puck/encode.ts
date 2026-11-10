import { CAP_FRAMES, GOALS_TO_WIN, PHASE, POSSESSION_FRAMES, PUCK_MAX_SPEED, RULE_MALLET_SPEED } from './constants'
import type { PuckState } from './state'

// Observation layout and action bins for the training env. Only + - * / sqrt abs min max floor round (the sim's rule).

/** One decision every FRAME_SKIP sim frames: 30 a second. */
export const FRAME_SKIP = 2
/** Target bins over the seat's own half: the action is (x bin, y bin), nvec (11, 9). */
export const BIN_X = 11
export const BIN_Y = 9

/** The delayed part: what a seat sees of the puck, the other mallet and the match. */
export const VIEW_FEATURES = 15
/** The undelayed part: the seat's own mallet, the target it holds and how long it has held it. */
export const OWN_FEATURES = 8
export const OBS_FEATURES = VIEW_FEATURES + OWN_FEATURES

/**
 * Writes one seat's delayed view into out[offset..]. Always the seat's own view: it defends y = 0, so for seat 1
 * x becomes 1 - x, y becomes 2 - y and velocities flip.
 * 0..3 puck x y vx vy, 4..7 the other mallet, 8 my goals, 9 their goals, 10 ready freeze, 11 serve is mine,
 * 12 possession (positive in my half), 13 time used, 14 sudden death.
 */
export function writeSeatView(s: PuckState, seat: 0 | 1, out: Float32Array, offset: number): void {
  const o = offset
  const f = seat === 0 ? 1 : -1
  const ox = seat === 0 ? 0 : 1
  const oy = seat === 0 ? 0 : 2
  const them = s.m[1 - seat]!
  out[o] = (ox + f * s.px) * 2 - 1
  out[o + 1] = oy + f * s.py - 1
  out[o + 2] = (f * s.pvx) / PUCK_MAX_SPEED
  out[o + 3] = (f * s.pvy) / PUCK_MAX_SPEED
  out[o + 4] = (ox + f * them.x) * 2 - 1
  out[o + 5] = oy + f * them.y - 1
  out[o + 6] = (f * them.vx) / RULE_MALLET_SPEED
  out[o + 7] = (f * them.vy) / RULE_MALLET_SPEED
  out[o + 8] = s.score[seat]! / GOALS_TO_WIN
  out[o + 9] = s.score[1 - seat]! / GOALS_TO_WIN
  out[o + 10] = s.phase === PHASE.READY ? 1 : 0
  out[o + 11] = s.serveSeat === seat ? 1 : 0
  const inMine = s.possHalf === seat
  out[o + 12] = (inMine ? s.possFrames : -s.possFrames) / POSSESSION_FRAMES
  out[o + 13] = s.frame / CAP_FRAMES
  out[o + 14] = s.sudden
}

/**
 * Writes the own block into out[offset..]: the live mallet (x, y over its half, velocity), the target it
 * holds in the same view, frames since it last changed it (0..1) and a flag that the last proposal was refused.
 */
export function writeOwn(s: PuckState, seat: 0 | 1, sinceChange: number, refused: number, out: Float32Array, offset: number): void {
  const m = s.m[seat]!
  const f = seat === 0 ? 1 : -1
  const ox = seat === 0 ? 0 : 1
  const oy = seat === 0 ? 0 : 2
  out[offset] = (ox + f * m.x) * 2 - 1
  out[offset + 1] = (oy + f * m.y) * 2 - 1
  out[offset + 2] = (f * m.vx) / RULE_MALLET_SPEED
  out[offset + 3] = (f * m.vy) / RULE_MALLET_SPEED
  out[offset + 4] = (ox + f * m.tx) * 2 - 1
  out[offset + 5] = (oy + f * m.ty) * 2 - 1
  out[offset + 6] = sinceChange
  out[offset + 7] = refused
}

/** Centre of a target bin as a point in the own half, 0..1 on each axis. */
export const binX = (bx: number): number => (bx + 0.5) / BIN_X
export const binY = (by: number): number => (by + 0.5) / BIN_Y

/** Roughly normal noise with sd 1 and bounded at 3.46 sd: four uniforms (no log or trig, so the rng stream stays exact). */
export function noise(rng: { float(): number }): number {
  return (rng.float() + rng.float() + rng.float() + rng.float() - 2) * 1.7320508075688772
}
