import { M, MOVES } from '@duelwise/core/src/games/fighter/moves.ts'

// Maps every sim move id to a CC0 clip (Quaternius Universal Animation Library 1 and 2) and says how
// to turn the sim's moveFrame into a clip time, so a strike reaches its extended pose exactly on the
// first active frame, holds through the active frames and recovers over the sim's recovery. Pure data
// and arithmetic: no three.js here, so it is unit tested without a browser.

export type ClipPack = 'ual1' | 'ual2'

/** Every clip the renderer loads, with its duration in seconds (checked against the GLB files in animation-map.test.ts). */
export const CLIPS: Readonly<Record<string, { pack: ClipPack; duration: number }>> = {
  Idle_Loop: { pack: 'ual1', duration: 2.5 },
  Crouch_Idle_Loop: { pack: 'ual1', duration: 2.9333 },
  Crouch_Fwd_Loop: { pack: 'ual1', duration: 2 },
  Walk_Loop: { pack: 'ual1', duration: 1.3333 },
  Jump_Start: { pack: 'ual1', duration: 1.3333 },
  Jump_Loop: { pack: 'ual1', duration: 2.5 },
  Jump_Land: { pack: 'ual1', duration: 1.2667 },
  Sprint_Loop: { pack: 'ual1', duration: 0.6667 },
  Roll: { pack: 'ual1', duration: 1.4667 },
  Hit_Chest: { pack: 'ual1', duration: 0.3333 },
  Hit_Head: { pack: 'ual1', duration: 0.4333 },
  Punch_Jab: { pack: 'ual1', duration: 0.8667 },
  Punch_Cross: { pack: 'ual1', duration: 1 },
  Spell_Simple_Shoot: { pack: 'ual1', duration: 0.5 },
  Death01: { pack: 'ual1', duration: 2.4 },
  Hit_Knockback: { pack: 'ual2', duration: 0.8333 },
  Sword_Block: { pack: 'ual2', duration: 1.2333 },
  Idle_Shield_Break: { pack: 'ual2', duration: 1.0667 },
  Melee_Hook: { pack: 'ual2', duration: 0.4667 },
  Shield_Dash: { pack: 'ual2', duration: 1.1 },
  Shield_OneShot: { pack: 'ual2', duration: 0.8333 },
  OverhandThrow: { pack: 'ual2', duration: 1.3333 },
  NinjaJump_Start: { pack: 'ual2', duration: 0.9667 },
  Sword_Dash: { pack: 'ual2', duration: 1.5667 },
  Slide_Start: { pack: 'ual2', duration: 0.8333 },
  Sword_Heavy_Combo: { pack: 'ual2', duration: 4.3333 },
  LayToIdle: { pack: 'ual2', duration: 1.5333 },
  Idle_Shield_Loop: { pack: 'ual2', duration: 2.5 },
}

export type AnimKind = 'loop' | 'once' | 'strike'

export interface MoveAnim {
  clip: string
  kind: AnimKind
  /** loop: playback speed. */
  rate?: number
  /** loop: play backwards (walking back). */
  reverse?: boolean
  /** once and strike: clip time (s) at the first frame. */
  start?: number
  /** once: clip time at the last frame, held afterwards. strike: clip time at the last recovery frame. */
  end?: number
  /** strike: clip time of the extended pose, measured offline as the frame of furthest limb reach. */
  peak?: number
  /** strike: clip seconds the extended pose is held across the active frames. */
  hold?: number
  /** once: how many sim frames the start to end sweep takes (default: the move's total frames). */
  frames?: number
  /** The legs and torso come from this looping clip and only the arms from `clip` (crouch and air normals). */
  base?: string
}

const loop = (clip: string, rate = 1, reverse = false): MoveAnim => ({ clip, kind: 'loop', rate, reverse })
const once = (clip: string, start: number, end: number, frames?: number): MoveAnim => ({ clip, kind: 'once', start, end, frames })
const strike = (clip: string, peak: number, hold = 0.05, start = 0, end?: number, base?: string): MoveAnim => ({
  clip,
  kind: 'strike',
  start,
  peak,
  hold,
  end: end ?? CLIPS[clip]!.duration,
  base,
})

/** One entry per move id in packages/core/src/games/fighter/moves.ts. */
export const ANIMATION_MAP: Readonly<Record<number, MoveAnim>> = {
  [M.IDLE]: loop('Idle_Loop'),
  [M.CROUCH]: loop('Crouch_Idle_Loop'),
  [M.WALK_F]: loop('Walk_Loop', 1.25),
  [M.WALK_B]: loop('Walk_Loop', 1, true),
  [M.PREJUMP]: once('Jump_Start', 0, 0.45, 4),
  [M.JUMP]: loop('Jump_Loop', 0.5),
  [M.DASH_F]: loop('Sprint_Loop', 1.6),
  [M.DASH_B]: once('Roll', 0, 1.1, 22),
  [M.HITSTUN]: once('Hit_Chest', 0, 0.12, 6),
  [M.BLOCKSTUN]: once('Sword_Block', 0, 0.29, 5),
  [M.KNOCKDOWN]: once('Hit_Knockback', 0, 0.83, 30),
  [M.THROWN]: once('Hit_Knockback', 0, 0.5, 10),
  [M.TECH]: once('Hit_Chest', 0, 0.33, 14),
  [M.PARRIED]: once('Idle_Shield_Break', 0, 0.6, 12),
  [M.STAND_L]: strike('Punch_Jab', 0.202),
  [M.STAND_M]: strike('Punch_Cross', 0.267),
  [M.STAND_H]: strike('Melee_Hook', 0.272),
  [M.FORWARD_H]: strike('Shield_Dash', 0.22),
  [M.CROUCH_L]: strike('Punch_Jab', 0.202, 0.05, 0, undefined, 'Crouch_Idle_Loop'),
  [M.CROUCH_M]: strike('Punch_Cross', 0.267, 0.05, 0, undefined, 'Crouch_Idle_Loop'),
  [M.CROUCH_H]: strike('Slide_Start', 0.264),
  [M.AIR_L]: strike('Punch_Jab', 0.202, 0.05, 0, undefined, 'Jump_Loop'),
  [M.AIR_M]: strike('Punch_Cross', 0.267, 0.05, 0, undefined, 'Jump_Loop'),
  [M.AIR_H]: strike('Melee_Hook', 0.272, 0.05, 0, undefined, 'Jump_Loop'),
  [M.THROW]: strike('OverhandThrow', 0.378, 0.08),
  [M.SPARK]: once('Spell_Simple_Shoot', 0, 0.5),
  [M.RISER]: strike('NinjaJump_Start', 0.274, 0.12),
  [M.EMBER]: once('Spell_Simple_Shoot', 0, 0.5),
  [M.DEFLECT]: once('Shield_OneShot', 0, 0.6),
  [M.RUSH]: loop('Sprint_Loop', 1.5),
  [M.BREAKER]: strike('Sword_Heavy_Combo', 2.6, 0.1, 2, 3.2),
}

/** Move ids with no mapping (must be empty). */
export function unmappedMoves(): number[] {
  const out: number[] = []
  for (let id = 0; id < MOVES.length; id++) if (MOVES[id] !== undefined && (ANIMATION_MAP[id] === undefined || CLIPS[ANIMATION_MAP[id]!.clip] === undefined)) out.push(id)
  return out
}

/** Clip names every character needs loaded (including the base clips of overlay moves). */
export function requiredClips(): string[] {
  const set = new Set<string>()
  for (const a of Object.values(ANIMATION_MAP)) {
    set.add(a.clip)
    if (a.base) set.add(a.base)
  }
  return [...set]
}

const FPS = 60
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Clip time in seconds for a move at `moveFrame` (1 on the first frame of the move). `simFrame` drives
 * loops so idle and walk cycles stay continuous across moves; `frac` in [0, 1) is the render
 * interpolation toward the next sim frame (0 during hitstop).
 */
export function clipTime(anim: MoveAnim, moveId: number, moveFrame: number, simFrame: number, frac = 0): number {
  const dur = CLIPS[anim.clip]!.duration
  if (anim.kind === 'loop') {
    const t = ((simFrame + frac) / FPS) * (anim.rate ?? 1)
    const wrapped = t % dur
    return anim.reverse ? dur - wrapped : wrapped
  }
  const mv = MOVES[moveId]!
  const f = Math.max(0, moveFrame + frac)
  if (anim.kind === 'once') {
    const frames = Math.max(1, anim.frames ?? mv.total)
    const u = clamp(f / frames, 0, 1)
    return (anim.start ?? 0) + ((anim.end ?? dur) - (anim.start ?? 0)) * u
  }
  // strike: startup sweeps start to peak, the active frames hold the extended pose, recovery returns.
  const start = anim.start ?? 0
  const peak = anim.peak ?? 0
  const hold = anim.hold ?? 0
  const end = anim.end ?? dur
  const lastActive = mv.startup + mv.active - 1
  if (f <= mv.startup) return start + (peak - start) * clamp(f / Math.max(1, mv.startup), 0, 1)
  if (f <= lastActive) return peak + hold * clamp((f - mv.startup) / Math.max(1, lastActive - mv.startup), 0, 1)
  const rec = Math.max(1, mv.total - lastActive)
  const a = peak + hold
  return a + (end - a) * clamp((f - lastActive) / rec, 0, 1)
}

/** Time for the lower-body base clip of an overlay move. */
export function baseTime(base: string, simFrame: number, frac = 0): number {
  const dur = CLIPS[base]!.duration
  return (((simFrame + frac) / FPS) * (base === 'Jump_Loop' ? 0.5 : 1)) % dur
}
