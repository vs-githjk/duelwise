import type { PuckObs } from '@duelwise/core/src/games/puck/core'
import { CAP_FRAMES, GOALS_TO_WIN, POSSESSION_FRAMES, PUCK_MAX_SPEED, RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import { FRAME_SKIP, OBS_FEATURES, OWN_FEATURES, VIEW_FEATURES, writeOwn, writeSeatView } from '@duelwise/core/src/games/puck/encode'
import type { PuckState } from '@duelwise/core/src/games/puck/state'

// What the puck agent is shown and when. Mirrors the training env (packages/core/src/games/puck/env.ts): one decision
// every FRAME_SKIP sim frames counted from frame 0, and the view a decision reads is the state `delayFrames` frames
// earlier (the seat's HumanLimiter keeps it). The encoding is the trainer's own (encode.ts); nothing is re-derived here.
// No onnxruntime import: the page uses this file too.

export { FRAME_SKIP, OBS_FEATURES, OWN_FEATURES, VIEW_FEATURES }

/**
 * The live observation the page passes to act(): the seat's view of the sim as it is right now, in the trainer's layout.
 * Features 0..14 are the live match view (the agent records them and reads them back `delayFrames` later, never now);
 * 15..20 are the seat's own mallet and held target (read live, like a hand feels itself); 21 and 22 (frames since the
 * target changed, last proposal refused) belong to the agent's own limiter, which overwrites them.
 */
export function liveObs(s: PuckState, seat: 0 | 1, out: Float32Array = new Float32Array(OBS_FEATURES)): Float32Array {
  writeSeatView(s, seat, out, 0)
  writeOwn(s, seat, 0, 0, out, VIEW_FEATURES)
  return out
}

export interface ViewDue {
  /** The agent must record this frame's view (a later decision will read it). */
  capture: boolean
  /** The agent decides on this frame. */
  decide: boolean
}

/**
 * Which calls the agent needs on a frame. Frame 0 is always recorded; after that a frame is recorded when a decision
 * `delayFrames` later will want it (env.ts capture). The page may also simply call act() every frame: the agent applies this itself.
 */
export function viewDue(frame: number, delayFrames: number): ViewDue {
  return { capture: frame === 0 || (frame + delayFrames) % FRAME_SKIP === 0, decide: frame % FRAME_SKIP === 0 }
}

/**
 * The scripted bots read a PuckObs. This rebuilds one from what the agent is allowed to see: the delayed view (features 0..14,
 * the inverse of writeSeatView) and the seat's own mallet (15..18, the inverse of writeOwn). Exact up to float32 rounding.
 */
export function obsFromSeen(seen: Float32Array): PuckObs {
  return {
    puck: [(seen[0]! + 1) / 2, seen[1]! + 1, seen[2]! * PUCK_MAX_SPEED, seen[3]! * PUCK_MAX_SPEED],
    them: [(seen[4]! + 1) / 2, seen[5]! + 1, seen[6]! * RULE_MALLET_SPEED, seen[7]! * RULE_MALLET_SPEED],
    me: [(seen[VIEW_FEATURES]! + 1) / 2, (seen[VIEW_FEATURES + 1]! + 1) / 2, seen[VIEW_FEATURES + 2]! * RULE_MALLET_SPEED, seen[VIEW_FEATURES + 3]! * RULE_MALLET_SPEED],
    score: [Math.round(seen[8]! * GOALS_TO_WIN), Math.round(seen[9]! * GOALS_TO_WIN)],
    phase: seen[10] === 1 ? 0 : 1,
    serveToMe: seen[11] === 1 ? 1 : 0,
    possession: Math.round(seen[12]! * POSSESSION_FRAMES),
    frame: Math.round(seen[13]! * CAP_FRAMES),
  }
}
