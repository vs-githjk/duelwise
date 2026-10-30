import type { MapData } from './map'

const EPS = 1e-9

/**
 * First distance along the ray (origin o, direction d, in units of d) at which it enters the box,
 * or Infinity if it misses or the entry is beyond tmax. Slab method; IEEE basic operations only.
 */
export function rayAabb(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tmax: number,
): number {
  let tmin = 0
  let tm = tmax
  if (dx > -EPS && dx < EPS) {
    if (ox < x0 || ox > x1) return Infinity
  } else {
    const inv = 1 / dx
    let a = (x0 - ox) * inv
    let b = (x1 - ox) * inv
    if (a > b) { const t = a; a = b; b = t }
    if (a > tmin) tmin = a
    if (b < tm) tm = b
    if (tmin > tm) return Infinity
  }
  if (dy > -EPS && dy < EPS) {
    if (oy < y0 || oy > y1) return Infinity
  } else {
    const inv = 1 / dy
    let a = (y0 - oy) * inv
    let b = (y1 - oy) * inv
    if (a > b) { const t = a; a = b; b = t }
    if (a > tmin) tmin = a
    if (b < tm) tm = b
    if (tmin > tm) return Infinity
  }
  if (dz > -EPS && dz < EPS) {
    if (oz < z0 || oz > z1) return Infinity
  } else {
    const inv = 1 / dz
    let a = (z0 - oz) * inv
    let b = (z1 - oz) * inv
    if (a > b) { const t = a; a = b; b = t }
    if (a > tmin) tmin = a
    if (b < tm) tm = b
    if (tmin > tm) return Infinity
  }
  return tmin
}

/** Nearest box hit along the ray within tmax, or Infinity. */
export function rayWorld(map: MapData, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number): number {
  const b = map.boxes
  let best = Infinity
  let lim = tmax
  for (let i = 0, o = 0; i < map.boxCount; i++, o += 6) {
    const t = rayAabb(ox, oy, oz, dx, dy, dz, b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!, b[o + 4]!, b[o + 5]!, lim)
    if (t < best) {
      best = t
      lim = t
    }
  }
  return best
}

/** True if a box lies strictly between the two points. */
export function segmentBlocked(map: MapData, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  return rayWorld(map, ax, ay, az, bx - ax, by - ay, bz - az, 1 - 1e-6) < 1 - 1e-6
}
