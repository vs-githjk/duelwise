import { AIR_HURT_HALF, AIR_HURT_Y0, AIR_HURT_Y1, CROUCH_HURT, STAND_HURT } from './constants'
import { M, MOVES, isCrouchState } from './moves'
import type { Fighter } from './state'

export function overlaps(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): boolean {
  return ax0 <= bx1 && bx0 <= ax1 && ay0 <= by1 && by0 <= ay1
}

export function isAirborne(f: Fighter): boolean {
  return f.pos.y > 0
}

/** True when this fighter ducks: used for hurtbox height and for block checks. */
export function isCrouching(f: Fighter): boolean {
  return isCrouchState(f.moveId) || ((f.moveId === M.BLOCKSTUN || f.moveId === M.HITSTUN) && f.crouchBlock === 1)
}

/** World-space box of the active hitbox of the fighter's current move, written to out[0..3]. */
export function hitBoxWorld(a: Fighter, out: Int32Array): void {
  const r = MOVES[a.moveId]!.hit
  if (a.facing > 0) {
    out[0] = a.pos.x + r.x0
    out[2] = a.pos.x + r.x1
  } else {
    out[0] = a.pos.x - r.x1
    out[2] = a.pos.x - r.x0
  }
  out[1] = a.pos.y + r.y0
  out[3] = a.pos.y + r.y1
}

export function isActiveFrame(f: Fighter): boolean {
  const m = MOVES[f.moveId]!
  return m.hasHit && !m.projectile && f.moveFrame >= m.startup && f.moveFrame <= m.startup + m.active - 1
}

/** Is the extended limb of the fighter's current move a hurtbox now (active frames and the recovery limb)? */
export function hasLimbHurt(f: Fighter): boolean {
  const m = MOVES[f.moveId]!
  return m.hasHit && !m.projectile && f.moveFrame >= m.startup && f.moveFrame <= m.limbTo
}

const ext = new Int32Array(4)

/** Does the world-space box touch any hurtbox of d (body box plus the extended limb from its first active frame through its recovery limb)? */
export function hurtOverlaps(d: Fighter, x0: number, y0: number, x1: number, y1: number): boolean {
  let bx0: number
  let by0: number
  let bx1: number
  let by1: number
  if (d.pos.y > 0) {
    bx0 = d.pos.x - AIR_HURT_HALF
    bx1 = d.pos.x + AIR_HURT_HALF
    by0 = d.pos.y + AIR_HURT_Y0
    by1 = d.pos.y + AIR_HURT_Y1
  } else {
    const h = isCrouching(d) ? CROUCH_HURT : STAND_HURT
    bx0 = d.pos.x + h[0]
    by0 = h[1]
    bx1 = d.pos.x + h[2]
    by1 = h[3]
  }
  if (overlaps(x0, y0, x1, y1, bx0, by0, bx1, by1)) return true
  if (hasLimbHurt(d)) {
    hitBoxWorld(d, ext)
    if (overlaps(x0, y0, x1, y1, ext[0]!, ext[1]!, ext[2]!, ext[3]!)) return true
  }
  return false
}

/** Is the fighter invulnerable to this attack type (INVULN_* mask) on this frame? */
export function isInvulnerable(f: Fighter, mask: number): boolean {
  const m = MOVES[f.moveId]!
  return (m.invulnMask & mask) !== 0 && f.moveFrame >= m.invulnFrom && f.moveFrame <= m.invulnTo
}
