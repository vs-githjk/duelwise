import { CELLS, FLEET_SIZE, shipCells, type Placement } from '@duelwise/core/src/games/fleet/core'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'

// The luck line for Stormglass (design spec 2.6), shared by the result card and the report so both say the same thing.
// Pure and small: no game core is imported, so the play page does not pull the report code into its bundle.

const RUNS = 400
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five']

function partlyHit(hits: Set<number>, target: Placement[]): boolean {
  return target.some((p) => {
    const n = shipCells(p).filter((c) => hits.has(c)).length
    return n > 0 && n < p.length
  })
}

/**
 * Hunting shots: shots fired while no ship stood partly hit, counted only up to and including the shot that sank the last ship
 * the shooter found. Finishing shots (after a hit, before the sink) are not counted, and neither are shots after the last sink,
 * because the careful hunt it is compared with (`expectedHunting`) stops at that sink too. With no sink, every shot counts.
 */
export function huntingShots(shots: number[], target: Placement[]): number {
  const hits = new Set<number>()
  let end = shots.length
  let last = -1
  shots.forEach((cell, i) => {
    if (target.some((p) => shipCells(p).includes(cell))) hits.add(cell)
    if (target.some((p) => shipCells(p).includes(cell) && shipCells(p).every((c) => hits.has(c)))) last = i
  })
  if (last >= 0) end = last + 1
  const seen = new Set<number>()
  let hunting = 0
  for (const cell of shots.slice(0, end)) {
    if (!partlyHit(seen, target)) hunting++
    if (target.some((p) => shipCells(p).includes(cell))) seen.add(cell)
  }
  return hunting
}

/**
 * One careful hunt against this exact fleet: a random square of one checkerboard colour while hunting, a random neighbour of a hit once a
 * ship is partly hit. Good technique is the bar, not luck, so the comparison is with this and not with uniform shots. Returns the hunting shots used to sink `want` ships.
 */
function simulateHunt(target: Placement[], want: number, rng: Rng): number {
  const owner = new Array<number>(CELLS).fill(-1)
  target.forEach((p, i) => shipCells(p).forEach((c) => (owner[c] = i)))
  const left = target.map((p) => p.length)
  const fired = new Array<boolean>(CELLS).fill(false)
  const hitCells: number[] = []
  let sunk = 0
  let hunting = 0
  const colour = rng.int(2)
  while (sunk < want) {
    const open = left.some((n, i) => n > 0 && n < target[i]!.length)
    let pool: number[] = []
    if (open) {
      const seen = new Set<number>()
      for (const c of hitCells) {
        if (left[owner[c]!]! === 0) continue
        const r = Math.floor(c / FLEET_SIZE)
        const col = c % FLEET_SIZE
        if (r > 0) seen.add(c - FLEET_SIZE)
        if (r < FLEET_SIZE - 1) seen.add(c + FLEET_SIZE)
        if (col > 0) seen.add(c - 1)
        if (col < FLEET_SIZE - 1) seen.add(c + 1)
      }
      pool = [...seen].filter((c) => !fired[c])
    }
    if (pool.length === 0) {
      for (let c = 0; c < CELLS; c++) if (!fired[c] && (Math.floor(c / FLEET_SIZE) + c) % 2 === colour) pool.push(c)
      if (pool.length === 0) for (let c = 0; c < CELLS; c++) if (!fired[c]) pool.push(c)
      if (!open) hunting++
    }
    if (pool.length === 0) break
    const cell = pool[rng.int(pool.length)]!
    fired[cell] = true
    const o = owner[cell]!
    if (o >= 0) {
      hitCells.push(cell)
      left[o]!--
      if (left[o] === 0) sunk++
    }
  }
  return hunting
}

/** Mean hunting shots of a careful hunt to sink `want` ships of this fleet (400 runs). */
export function expectedHunting(target: Placement[], want: number): number {
  // Seeded from the fleet itself, so the card and the report agree and a rebuilt report never changes.
  let seed = 0x57a6
  for (const p of target) seed = (Math.imul(seed, 31) + p.cell * 2 + (p.vertical ? 1 : 0)) >>> 0
  const rng = makeRng(seed)
  let total = 0
  for (let i = 0; i < RUNS; i++) total += simulateHunt(target, want, rng)
  return total / RUNS
}

export type LuckVerdict = 'lucky' | 'unlucky' | 'about even'

export function luckVerdict(actual: number, expected: number): LuckVerdict {
  if (actual < expected * 0.85) return 'lucky'
  if (actual > expected * 1.15) return 'unlucky'
  return 'about even'
}

export interface LuckInput {
  won: boolean
  /** Shots the winner fired. */
  winnerShots: number
  /** Ships the player sank. */
  found: number
  hunting: number
  expected: number
  opponent: string
  /** Word the line about "the player" for a stranger. */
  third?: boolean
}

/** The luck line (design spec 2.6): compares the hunt to chance. Always ends with the verdict clause. */
export function fleetLuckLine(i: LuckInput): string {
  const verdict = luckVerdict(i.hunting, i.expected)
  const e = Math.max(1, Math.round(i.expected))
  const You = i.third ? 'The player' : 'You'
  const Your = i.third ? "The player's" : 'Your'
  const head = i.won ? `${You} sank all five in ${i.winnerShots} shots.` : `${i.opponent} sank ${i.third ? "the player's" : 'your'} fleet in ${i.winnerShots} shots.`
  const found = i.won ? 'for all five ships' : `for ${COUNT_WORDS[i.found] ?? i.found} ${i.found === 1 ? 'ship' : 'ships'} found`
  const tail = verdict === 'lucky' && !i.won ? `${You} ran lucky, and still lost on the chase.` : `${You} ran ${verdict}.`
  return `${head} ${Your} hunting shots: ${i.hunting} ${found}; a careful hunt needs about ${e}. ${tail}`
}
