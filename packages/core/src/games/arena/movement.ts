import type { MapData } from './map'
import { cosU, sinU } from './trig'
import type { Player } from './state'

// Source-style ground and air movement at 60 Hz. See docs/game-design/arena.md.

export const DT = 1 / 60
export const ACCEL = 5.5
export const FRICTION = 5.2
export const STOP_SPEED = 80
export const AIR_ACCEL = 12
export const AIR_WISH_CAP = 30
export const GRAVITY = 800
export const JUMP_VZ = 301.993
export const WALK_FACTOR = 0.52
export const CROUCH_FACTOR = 0.34
export const HULL_HALF = 16
export const H_STAND = 72
export const H_CROUCH = 54
export const EYE_STAND = 64
export const EYE_CROUCH = 46
export const STEP_HEIGHT = 18
const SQRT_HALF = Math.SQRT1_2

// Move codes: 0 neutral, then clockwise from forward (F, FR, R, BR, B, BL, L, FL).
const FWD = [0, 1, 1, 0, -1, -1, -1, 0, 1]
const SIDE = [0, 0, 1, 1, 1, 0, -1, -1, -1]

/** Top of the highest box under the hull that the feet can reach (a step of at most STEP_HEIGHT), else the floor. */
export function groundHeight(map: MapData, x: number, y: number, z: number): number {
  const b = map.boxes
  let best = 0
  const reach = z + STEP_HEIGHT + 1e-9
  for (let i = 0, o = 0; i < map.boxCount; i++, o += 6) {
    const top = b[o + 5]!
    if (top <= best || top > reach) continue
    if (x + HULL_HALF <= b[o]! || x - HULL_HALF >= b[o + 3]! || y + HULL_HALF <= b[o + 1]! || y - HULL_HALF >= b[o + 4]!) continue
    best = top
  }
  return best
}

/** Does the hull at (x, y, z) of height h overlap the other seat's hull? */
function hitsOther(o: Player | null, x: number, y: number, z: number, h: number): boolean {
  if (o === null || o.alive === 0) return false
  if (Math.abs(x - o.x) >= 2 * HULL_HALF || Math.abs(y - o.y) >= 2 * HULL_HALF) return false
  return z < o.z + hullHeight(o) && o.z < z + h
}

function blockedAt(map: MapData, x: number, y: number, z: number, h: number, o: Player | null, overlapping: boolean): boolean {
  if (!overlapping && hitsOther(o, x, y, z, h)) return true
  const b = map.boxes
  const stepTop = z + STEP_HEIGHT
  const head = z + h
  for (let i = 0, o = 0; i < map.boxCount; i++, o += 6) {
    if (b[o + 5]! <= stepTop) continue
    if (b[o + 2]! >= head) continue
    if (x + HULL_HALF <= b[o]! || x - HULL_HALF >= b[o + 3]! || y + HULL_HALF <= b[o + 1]! || y - HULL_HALF >= b[o + 4]!) continue
    return true
  }
  return false
}

export function eyeHeight(p: Player): number {
  return p.crouch === 1 ? EYE_CROUCH : EYE_STAND
}
export function hullHeight(p: Player): number {
  return p.crouch === 1 ? H_CROUCH : H_STAND
}

export function movePlayer(
  p: Player, map: MapData, mv: number, walk: number, crouch: number, jump: number, maxSpeed: number,
  other: Player | null = null,
): void {
  p.crouch = crouch
  const h = crouch === 1 ? H_CROUCH : H_STAND
  let wx = 0
  let wy = 0
  let wish = 0
  if (mv !== 0) {
    const f = FWD[mv]!
    const sd = SIDE[mv]!
    const cy = cosU(p.yaw)
    const sy = sinU(p.yaw)
    wx = f * cy + sd * sy
    wy = f * sy - sd * cy
    if (f !== 0 && sd !== 0) {
      wx *= SQRT_HALF
      wy *= SQRT_HALF
    }
    wish = maxSpeed * (crouch === 1 ? CROUCH_FACTOR : walk === 1 ? WALK_FACTOR : 1)
  }
  const jumpEdge = jump === 1 && p.prevJump === 0
  p.prevJump = jump
  if (p.onGround === 1 && jumpEdge) {
    p.vz = JUMP_VZ
    p.onGround = 0
  }
  if (p.onGround === 1) {
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
    if (speed < 0.1) {
      p.vx = 0
      p.vy = 0
    } else {
      const control = speed < STOP_SPEED ? STOP_SPEED : speed
      let ns = speed - control * FRICTION * DT
      if (ns < 0) ns = 0
      const k = ns / speed
      p.vx *= k
      p.vy *= k
    }
    if (wish > 0) {
      const add = wish - (p.vx * wx + p.vy * wy)
      if (add > 0) {
        let a = ACCEL * DT * wish
        if (a > add) a = add
        p.vx += a * wx
        p.vy += a * wy
      }
    }
  } else if (wish > 0) {
    const cap = wish < AIR_WISH_CAP ? wish : AIR_WISH_CAP
    const add = cap - (p.vx * wx + p.vy * wy)
    if (add > 0) {
      let a = AIR_ACCEL * wish * DT
      if (a > add) a = add
      p.vx += a * wx
      p.vy += a * wy
    }
  }

  // Seats never end a move inside each other. Already overlapping (a landing on a head) may walk out.
  const overlapping = hitsOther(other, p.x, p.y, p.z, h)
  // Per-axis move. On contact, bisect to rest against the face instead of stopping short.
  const dx = p.vx * DT
  if (dx !== 0) {
    if (!blockedAt(map, p.x + dx, p.y, p.z, h, other, overlapping)) p.x += dx
    else {
      let lo = 0
      let hi = 1
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) * 0.5
        if (blockedAt(map, p.x + dx * mid, p.y, p.z, h, other, overlapping)) hi = mid
        else lo = mid
      }
      p.x += dx * lo
      p.vx = 0
    }
  }
  const dy = p.vy * DT
  if (dy !== 0) {
    if (!blockedAt(map, p.x, p.y + dy, p.z, h, other, overlapping)) p.y += dy
    else {
      let lo = 0
      let hi = 1
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) * 0.5
        if (blockedAt(map, p.x, p.y + dy * mid, p.z, h, other, overlapping)) hi = mid
        else lo = mid
      }
      p.y += dy * lo
      p.vy = 0
    }
  }

  const gh = groundHeight(map, p.x, p.y, p.z)
  if (p.onGround === 1) {
    if (p.z > gh + 1e-6) p.onGround = 0
    else {
      p.z = gh
      p.vz = 0
    }
  }
  if (p.onGround === 0) {
    const vz1 = p.vz - GRAVITY * DT
    let nz = p.z + (p.vz + vz1) * 0.5 * DT
    p.vz = vz1
    if (vz1 <= 0 && nz <= gh) {
      nz = gh
      p.vz = 0
      p.onGround = 1
    }
    p.z = nz
  }
}
