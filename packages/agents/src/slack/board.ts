/**
 * A fast Slackwater board for search. Int8Array(64): 1 is seat 0, -1 is seat 1, 0 empty. `me` below is
 * 1 or -1 (seat 0 is 1). Moves are made and unmade in place with a caller-owned flip buffer, so a
 * search allocates nothing per node. Ray tables hold only rays long enough to close a line (2+ cells).
 *
 * The rules reference is `flipsFor` in the core; board.test coverage lives in search.test.ts
 * (a 300-game differential at every ply).
 */
export const SIZE = 8
export const CELLS = 64

/** Square weights: corners high, the squares beside them low. Copied from the sim ladder. */
export const WEIGHTS: readonly number[] = [
  120, -20, 20, 5, 5, 20, -20, 120,
  -20, -40, -5, -5, -5, -5, -40, -20,
  20, -5, 15, 3, 3, 15, -5, 20,
  5, -5, 3, 3, 3, 3, -5, 5,
  5, -5, 3, 3, 3, 3, -5, 5,
  20, -5, 15, 3, 3, 15, -5, 20,
  -20, -40, -5, -5, -5, -5, -40, -20,
  120, -20, 20, 5, 5, 20, -20, 120,
]

/** Cells by weight, high first, ties by index: move generation walks this so moves come out ordered. */
export const ORDER: Int8Array = Int8Array.from(
  Array.from({ length: CELLS }, (_, i) => i).sort((a, b) => WEIGHTS[b]! - WEIGHTS[a]! || a - b),
)

const DIRS: readonly (readonly [number, number])[] = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
]

/** RAYS[p]: for each direction, the cells outward from p, kept only if 2 or more long. */
const RAYS: Int8Array[][] = Array.from({ length: CELLS }, (_, p) => {
  const out: Int8Array[] = []
  for (const [dr, dc] of DIRS) {
    const ray: number[] = []
    let r = Math.floor(p / SIZE) + dr
    let c = (p % SIZE) + dc
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
      ray.push(r * SIZE + c)
      r += dr
      c += dc
    }
    if (ray.length >= 2) out.push(Int8Array.from(ray))
  }
  return out
})

export function startBoard(): Int8Array {
  const b = new Int8Array(CELLS)
  b[27] = -1
  b[36] = -1
  b[28] = 1
  b[35] = 1
  return b
}

/** From the core's cells (0 empty, 1 seat 0, 2 seat 1). */
export function fromCells(cells: readonly number[]): Int8Array {
  const b = new Int8Array(CELLS)
  for (let i = 0; i < CELLS; i++) b[i] = cells[i] === 1 ? 1 : cells[i] === 2 ? -1 : 0
  return b
}

export function toCells(b: Int8Array): number[] {
  const out = new Array<number>(CELLS)
  for (let i = 0; i < CELLS; i++) out[i] = b[i] === 1 ? 1 : b[i] === -1 ? 2 : 0
  return out
}

/** Write the cells that `me` placing on p would flip into out; returns how many. 0 if p is taken. */
export function flipsInto(b: Int8Array, p: number, me: number, out: Int8Array): number {
  if (b[p] !== 0) return 0
  let n = 0
  const rays = RAYS[p]!
  for (let i = 0; i < rays.length; i++) {
    const ray = rays[i]!
    const len = ray.length
    let k = 0
    while (k < len && b[ray[k]!] === -me) k++
    if (k > 0 && k <= len && b[ray[k]!] === me) for (let j = 0; j < k; j++) out[n++] = ray[j]!
  }
  return n
}

/** True if `me` placing on p would flip anything. */
function hasFlip(b: Int8Array, p: number, me: number): boolean {
  if (b[p] !== 0) return false
  const rays = RAYS[p]!
  for (let i = 0; i < rays.length; i++) {
    const ray = rays[i]!
    const len = ray.length
    let k = 0
    while (k < len && b[ray[k]!] === -me) k++
    if (k > 0 && k < len && b[ray[k]!] === me) return true
  }
  return false
}

/** Fill out with `me`'s placements in ORDER (best squares first); returns the count. */
export function legalInto(b: Int8Array, me: number, out: Int8Array): number {
  let n = 0
  for (let i = 0; i < CELLS; i++) {
    const p = ORDER[i]!
    if (hasFlip(b, p, me)) out[n++] = p
  }
  return n
}

export function moveCount(b: Int8Array, me: number): number {
  let n = 0
  for (let p = 0; p < CELLS; p++) if (hasFlip(b, p, me)) n++
  return n
}

/** Allocating helpers for tests and callers outside the search loop. */
export function legalMoves(b: Int8Array, me: number): number[] {
  const buf = new Int8Array(CELLS)
  const n = legalInto(b, me, buf)
  return Array.from(buf.subarray(0, n))
}

export function flipsOf(b: Int8Array, p: number, me: number): number[] {
  const buf = new Int8Array(CELLS)
  const n = flipsInto(b, p, me, buf)
  return Array.from(buf.subarray(0, n))
}

/** Place on p for `me`, flipping into buf. Returns the flip count to hand to unmake. */
export function make(b: Int8Array, p: number, me: number, buf: Int8Array): number {
  const n = flipsInto(b, p, me, buf)
  if (n === 0) throw new Error('slack board: illegal move ' + p)
  b[p] = me
  for (let i = 0; i < n; i++) b[buf[i]!] = me
  return n
}

export function unmake(b: Int8Array, p: number, me: number, buf: Int8Array, n: number): void {
  b[p] = 0
  for (let i = 0; i < n; i++) b[buf[i]!] = -me
}

/** Discs of `me` minus discs of the other side. */
export function discDiff(b: Int8Array, me: number): number {
  let s = 0
  for (let i = 0; i < CELLS; i++) s += b[i]!
  return s * me
}

export function emptyCount(b: Int8Array): number {
  let e = 0
  for (let i = 0; i < CELLS; i++) if (b[i] === 0) e++
  return e
}
