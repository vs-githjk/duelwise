import { N_BUYS, N_MOVES, type ArenaInput } from './input'

// The arena's multi-discrete action for the training env (T10): nine small heads, one per control.
// The full input (input.ts) has 255 pitch and 511 yaw deltas, far too many classes for a policy
// head, so the trained policy picks from a few turn sizes. Humans use the same controls through the
// mouse (any delta); the bins only shape what the network can output.
//
// Heads: move (9), walk (2), crouch (2), jump (2), fire (2), reload (2), yaw bin (9), pitch bin (7), buy (4).

/** Yaw delta per frame in angle units (8192 per turn) for each yaw bin, held for FRAME_SKIP frames. */
export const YAW_BINS: readonly number[] = [-200, -100, -40, -12, 0, 12, 40, 100, 200]
/** Pitch delta per frame for each pitch bin, positive looks up. */
export const PITCH_BINS: readonly number[] = [-60, -20, -5, 0, 5, 20, 60]
/** Buy choices a policy may make: 0 none, 1 ridgeline, 2 carbine, 3 armor. */
export const N_POLICY_BUYS = 4

export const ACTION_NVEC: readonly number[] = [N_MOVES, 2, 2, 2, 2, 2, YAW_BINS.length, PITCH_BINS.length, N_POLICY_BUYS]
export const ACTION_DIMS = ACTION_NVEC.length

/**
 * The move head's extra value in the training env (R15): "keep the held input". The seat's move, walk, crouch,
 * jump, fire and reload stay exactly as the limiter holds them (free of APM); the turn and buy heads still apply.
 * A trained policy with this value has a move head of N_MOVES + 1 logits (ACTION_NVEC_V2); the shipped runtime
 * agent reads the first N_MOVES until it is updated to v2 (T26).
 */
export const KEEP_MOVE = N_MOVES
export const ACTION_NVEC_V2: readonly number[] = [N_MOVES + 1, ...ACTION_NVEC.slice(1)]

/** The index of the zero-turn bin on each axis. */
export const YAW_ZERO_BIN = YAW_BINS.indexOf(0)
export const PITCH_ZERO_BIN = PITCH_BINS.indexOf(0)

/** Checks that actions[offset..offset+ACTION_DIMS) are inside their heads; returns the bad head or -1. */
export function badHead(actions: Int32Array, offset: number): number {
  for (let d = 0; d < ACTION_DIMS; d++) {
    const v = actions[offset + d]!
    if (!Number.isInteger(v) || v < 0 || v >= ACTION_NVEC_V2[d]!) return d
  }
  return -1
}

/** Policy heads to the full input. The caller has validated the heads with badHead and handled KEEP_MOVE. */
export function inputFromHeads(actions: Int32Array, offset: number): ArenaInput {
  const a = (d: number): number => actions[offset + d]!
  return {
    move: a(0),
    walk: a(1),
    crouch: a(2),
    jump: a(3),
    fire: a(4),
    reload: a(5),
    yaw: YAW_BINS[a(6)]!,
    pitch: PITCH_BINS[a(7)]!,
    buy: a(8),
  }
}

/**
 * Index of the bin for `v`: the nearest one, or, when `rand` is given, one of the two bins around `v` chosen with
 * probability proportional to closeness, so the expected turn equals `v` (a bot's small sweep of 5 units must not
 * become 0 just because the bins are 0 and 12).
 */
function binFor(bins: readonly number[], v: number, rand?: () => number): number {
  let near = 0
  for (let i = 1; i < bins.length; i++) if (Math.abs(bins[i]! - v) < Math.abs(bins[near]! - v)) near = i
  if (!rand) return near
  let lo = -1
  let hi = -1
  for (let i = 0; i < bins.length; i++) {
    if (bins[i]! <= v && (lo < 0 || bins[i]! > bins[lo]!)) lo = i
    if (bins[i]! >= v && (hi < 0 || bins[i]! < bins[hi]!)) hi = i
  }
  if (lo < 0) return hi
  if (hi < 0 || lo === hi) return lo
  return rand() < (v - bins[lo]!) / (bins[hi]! - bins[lo]!) ? hi : lo
}

/**
 * The full input to policy heads, written to out[offset..offset+ACTION_DIMS): what a scripted bot "said" in the
 * policy's own words. With `rand` the turn bins are rounded stochastically (see binFor).
 */
export function headsFromInput(i: ArenaInput, out: Int32Array, offset: number, rand?: () => number): void {
  out[offset] = i.move
  out[offset + 1] = i.walk
  out[offset + 2] = i.crouch
  out[offset + 3] = i.jump
  out[offset + 4] = i.fire
  out[offset + 5] = i.reload
  out[offset + 6] = binFor(YAW_BINS, i.yaw, rand)
  out[offset + 7] = binFor(PITCH_BINS, i.pitch, rand)
  out[offset + 8] = Math.min(i.buy, N_POLICY_BUYS - 1)
}

export { N_BUYS }

/** The first head of a seat's action is -1 - index of a scripted bot (bots.ts ARENA_BOT_KINDS) to have the env play that seat with it. */
export const ARENA_BOT_SENTINEL_BASE = -1
