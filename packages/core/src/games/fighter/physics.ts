import { GRAVITY, MAX_SEPARATION, PUSH_HALF, PUSH_MAX_Y, STAGE_HALF } from './constants'
import type { Fighter, FighterState } from './state'

/** Moves a fighter through the air for one frame. Returns true on the frame it lands. */
export function airMotion(f: Fighter): boolean {
  f.pos.x += f.vel.x
  f.pos.y += f.vel.y
  f.vel.y -= GRAVITY
  if (f.pos.y <= 0) {
    f.pos.y = 0
    f.vel.x = 0
    f.vel.y = 0
    return true
  }
  return false
}

export function clampWalls(f: Fighter): void {
  if (f.pos.x > STAGE_HALF) f.pos.x = STAGE_HALF
  else if (f.pos.x < -STAGE_HALF) f.pos.x = -STAGE_HALF
}

/** Keeps two low fighters from overlapping; a fighter high in the air passes over. */
export function separate(s: FighterState): void {
  const a = s.fighters[0]
  const b = s.fighters[1]
  if (a.pos.y > PUSH_MAX_Y || b.pos.y > PUSH_MAX_Y) return
  const dx = b.pos.x - a.pos.x
  const adx = dx < 0 ? -dx : dx
  const min = PUSH_HALF * 2
  if (adx >= min) return
  // On an exact overlap, split by facing (fighter a is pushed behind itself); same facing falls back to seat order.
  const sign = dx > 0 ? 1 : dx < 0 ? -1 : a.facing !== b.facing ? a.facing : 1
  const mv = Math.floor((min - adx + 1) / 2)
  a.pos.x -= sign * mv
  b.pos.x += sign * mv
  const aOver = a.pos.x > STAGE_HALF ? a.pos.x - STAGE_HALF : a.pos.x < -STAGE_HALF ? a.pos.x + STAGE_HALF : 0
  if (aOver !== 0) {
    a.pos.x -= aOver
    b.pos.x -= aOver
  }
  const bOver = b.pos.x > STAGE_HALF ? b.pos.x - STAGE_HALF : b.pos.x < -STAGE_HALF ? b.pos.x + STAGE_HALF : 0
  if (bOver !== 0) {
    b.pos.x -= bOver
    a.pos.x -= bOver
  }
  clampWalls(a)
  clampWalls(b)
}

/**
 * Keeps the fighters within MAX_SEPARATION. The one that moved apart this frame gives the ground back
 * (so a fighter who stands still is never dragged); any excess left over is split evenly. `ax` and `bx`
 * are the positions before the frame.
 */
export function limitSeparation(s: FighterState, ax: number, bx: number): void {
  const a = s.fighters[0]
  const b = s.fighters[1]
  const dx = b.pos.x - a.pos.x
  const adx = dx < 0 ? -dx : dx
  if (adx <= MAX_SEPARATION) return
  const sign = dx > 0 ? 1 : -1
  let excess = adx - MAX_SEPARATION
  // How far each moved away from the other this frame.
  const aAway = Math.max(0, -sign * (a.pos.x - ax))
  const bAway = Math.max(0, sign * (b.pos.x - bx))
  const takeA = Math.min(excess, aAway)
  a.pos.x += sign * takeA
  excess -= takeA
  const takeB = Math.min(excess, bAway)
  b.pos.x -= sign * takeB
  excess -= takeB
  if (excess > 0) {
    const half = Math.floor(excess / 2)
    a.pos.x += sign * half
    b.pos.x -= sign * (excess - half)
  }
}
