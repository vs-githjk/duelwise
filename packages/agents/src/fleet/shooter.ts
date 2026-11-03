import { FLEET_SIZE, shipCells, type FleetObs } from '@duelwise/core/src/games/fleet'
import type { Rng } from '@duelwise/core/src/types'
import type { FleetLevel } from './levels'
import { spotsFor } from './placer'

const N = FLEET_SIZE
const CELLS = N * N

/** What the shooter knows, read from the observation alone. */
interface Board {
  /** 0 unknown, 1 miss, 2 open hit (an unsunk ship), 3 part of a sunk ship. */
  state: Uint8Array
  /** Lengths of enemy ships still afloat. */
  left: number[]
  anyHit: boolean
}

function readBoard(obs: FleetObs): Board {
  const state = new Uint8Array(CELLS)
  for (const m of obs.shots) state[m.cell] = m.hit ? 2 : 1
  for (const p of obs.sunk) for (const c of shipCells(p)) state[c] = 3
  let anyHit = false
  for (let i = 0; i < CELLS; i++) if (state[i] === 2) anyHit = true
  return { state, left: obs.enemyLeft, anyHit }
}

const pick = (cells: number[], rng: Rng): number => cells[rng.int(cells.length)]!

function unknown(b: Board): number[] {
  const out: number[] = []
  for (let i = 0; i < CELLS; i++) if (b.state[i] === 0) out.push(i)
  return out
}

/** Unknown cells beside an open hit. */
function neighbours(b: Board): number[] {
  const seen = new Set<number>()
  for (let i = 0; i < CELLS; i++) {
    if (b.state[i] !== 2) continue
    const r = Math.floor(i / N)
    const c = i % N
    if (r > 0) seen.add(i - N)
    if (r < N - 1) seen.add(i + N)
    if (c > 0) seen.add(i - 1)
    if (c < N - 1) seen.add(i + 1)
  }
  return [...seen].filter((i) => b.state[i] === 0)
}

/**
 * One pass over every position every afloat ship could still take. A position is dead if it crosses a miss or a
 * sunk ship. With `weightHits`, positions that cover open hits count much more, and once any hit is open positions
 * that cover none are ignored, so the map hunts and targets with one rule.
 */
function densityMap(b: Board, weightHits: boolean): Float64Array {
  const w = new Float64Array(CELLS)
  const useHits = weightHits && b.anyHit
  for (const length of b.left) {
    for (const spot of spotsFor(length)) {
      const step = spot.vertical ? N : 1
      let hits = 0
      let ok = true
      for (let k = 0; k < length; k++) {
        const s = b.state[spot.cell + k * step]
        if (s === 1 || s === 3) {
          ok = false
          break
        }
        if (s === 2) hits++
      }
      if (!ok || (useHits && hits === 0)) continue
      const weight = useHits ? 1 + hits * hits * 20 : 1
      for (let k = 0; k < length; k++) if (b.state[spot.cell + k * step] === 0) w[spot.cell + k * step]! += weight
    }
  }
  return w
}

/** A uniformly random unknown cell among those with the highest weight. */
function best(w: Float64Array, b: Board, rng: Rng): number {
  let top = -1
  let cells: number[] = []
  for (let i = 0; i < CELLS; i++) {
    if (b.state[i] !== 0) continue
    if (w[i]! > top + 1e-9) {
      top = w[i]!
      cells = [i]
    } else if (Math.abs(w[i]! - top) < 1e-9) cells.push(i)
  }
  return pick(cells, rng)
}

/** The cell to fire at, 0..99. Reads only the observation. */
export function chooseShot(cfg: FleetLevel, obs: FleetObs, rng: Rng): number {
  const b = readBoard(obs)
  if (b.anyHit) {
    if (cfg.target === 'map') return best(densityMap(b, true), b, rng)
    const near = neighbours(b)
    if (near.length > 0 && (cfg.followRate >= 1 || rng.float() < cfg.followRate)) return pick(near, rng)
  }
  if (cfg.hunt === 'map') return best(densityMap(b, false), b, rng)
  const free = unknown(b)
  if (cfg.hunt === 'checkerboard') {
    const parity = free.filter((i) => (Math.floor(i / N) + (i % N)) % 2 === 0)
    return pick(parity.length > 0 ? parity : free, rng)
  }
  return pick(free, rng)
}
