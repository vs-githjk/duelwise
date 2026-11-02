import { CELLS, FLEET_SIZE, SHIPS, shipCells, type Placement } from '@duelwise/core/src/games/fleet/core'
import { makeRng } from '@duelwise/core/src/rng'

// The luck line for Stormglass (design spec 2.6), shared by the result card and the report so both say the same thing.
// Luck is what the dice gave beyond what the player's own choices should have earned: for every shot, the chance it hits given only what the player
// knew when firing, summed, against the hits actually scored. A well chosen shot raises the expected hits, so good technique is never read as luck.
// Pure: the only imports are the fleet rules and the seeded rng, so the play page does not pull the report code into its bundle.

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five']
const N = FLEET_SIZE
/** Fleets drawn per shot to estimate its hit chance. */
const SAMPLES = 200
/** How much more often the proposal picks a position that covers one more open hit. */
const FAVOUR = 8

export interface LuckScore {
  /** Shots that were fired at a fresh square. */
  shots: number
  hits: number
  /** Hits the squares chosen should have scored, given what was known at each shot. */
  expected: number
  /** Variance of the hit count if every shot had its stated chance. */
  variance: number
}

/** Every position of a ship of this length, as the squares it covers (flat: `length` squares per position). */
const spotCache = new Map<number, Int8Array>()
function spotsOf(length: number): Int8Array {
  let flat = spotCache.get(length)
  if (!flat) {
    const out: number[] = []
    for (const vertical of [false, true]) {
      for (let cell = 0; cell < CELLS; cell++) {
        const row = Math.floor(cell / N)
        const col = cell % N
        if (vertical ? row + length > N : col + length > N) continue
        out.push(...shipCells({ cell, vertical, length }))
      }
    }
    flat = Int8Array.from(out)
    spotCache.set(length, flat)
  }
  return flat
}

/**
 * The chance each unshot square holds a ship, given only what the shooter knew: the misses, the open hits, and the ships already sunk (known
 * exactly). The other fleet is placed the way the game places it (every ship uniformly over the positions left by the ships before it), so
 * the answer is the true posterior: weighted samples of fleets that fit every miss, cover every open hit, and hold no afloat ship lying wholly on hits.
 * A hunt that is skilful earns a high chance for the squares it picks; luck is only what is left over.
 */
function posterior(miss: Uint8Array, hit: Uint8Array, open: number[], sunk: Array<Placement | null>, rng: ReturnType<typeof makeRng>): Float64Array {
  const sums = new Float64Array(CELLS)
  let weightSum = 0
  const fixed = new Uint8Array(CELLS)
  sunk.forEach((p) => p && shipCells(p).forEach((c) => (fixed[c] = 1)))
  // `barred` is what a free ship may not touch: misses and sunk ships. `taken` adds the ships already placed in this sample.
  const barred = new Uint8Array(CELLS)
  for (let c = 0; c < CELLS; c++) barred[c] = miss[c]! | fixed[c]!
  const isOpen = new Uint8Array(CELLS)
  for (const c of open) isOpen[c] = 1
  const taken = new Uint8Array(CELLS)
  const covered = new Uint8Array(CELLS)
  const legal = new Int32Array(CELLS * 2)
  const gain = new Float64Array(CELLS * 2)
  for (let n = 0; n < SAMPLES; n++) {
    taken.fill(0)
    covered.fill(0)
    let weight = 1
    for (let id = 0; id < SHIPS.length; id++) {
      const length = SHIPS[id]!
      const spots = spotsOf(length)
      const count = spots.length / length
      const fix = sunk[id]
      let priorCount = 0
      let legalCount = 0
      let total = 0
      for (let s = 0; s < count; s++) {
        const at = s * length
        let free = true
        let ok = true
        let m = 1
        for (let k = 0; k < length; k++) {
          const c = spots[at + k]!
          if (taken[c] === 1) {
            free = false
            break
          }
          if (barred[c] === 1) ok = false
          else if (isOpen[c] === 1 && covered[c] === 0) m += FAVOUR
        }
        if (!free) continue
        priorCount++
        if (!ok || fix) continue
        legal[legalCount] = s
        gain[legalCount++] = m
        total += m
      }
      if (fix) {
        weight /= priorCount || Infinity
        for (const c of shipCells(fix)) taken[c] = 1
        continue
      }
      if (legalCount === 0) {
        weight = 0
        break
      }
      // The proposal favours positions that cover an open hit not yet covered, so a sample rarely misses one; the weight undoes the favour exactly.
      let pointer = rng.float() * total
      let pick = 0
      while (pick < legalCount - 1 && pointer >= gain[pick]!) pointer -= gain[pick++]!
      weight *= total / (gain[pick]! * priorCount)
      const at = legal[pick]! * length
      let wholly = true
      for (let k = 0; k < length; k++) {
        const c = spots[at + k]!
        taken[c] = 1
        covered[c] = 1
        if (hit[c] !== 1) wholly = false
      }
      // A ship lying wholly on hit squares would have been sunk and shown: the shooter was told it is still afloat.
      if (wholly) {
        weight = 0
        break
      }
    }
    if (weight === 0 || !open.every((c) => covered[c] === 1)) continue
    weightSum += weight
    for (let c = 0; c < CELLS; c++) if (covered[c] === 1) sums[c]! += weight
  }
  const out = new Float64Array(CELLS)
  if (weightSum === 0) return out.fill(-1)
  for (let c = 0; c < CELLS; c++) out[c] = sums[c]! / weightSum
  return out
}

/** Scores the shots of one player against the fleet they faced (their whole fleet, known once the match is over). */
export function luckScore(shots: number[], target: Placement[]): LuckScore {
  let seed = 0x57a6
  for (const p of target) seed = (Math.imul(seed, 31) + p.cell * 2 + (p.vertical ? 1 : 0)) >>> 0
  for (const c of shots) seed = (Math.imul(seed, 31) + c + 1) >>> 0
  const rng = makeRng(seed)
  const shot = new Uint8Array(CELLS)
  const miss = new Uint8Array(CELLS)
  const hitCell = new Uint8Array(CELLS)
  const sunk: Array<Placement | null> = target.map(() => null)
  let scored = 0
  let hits = 0
  let expected = 0
  let variance = 0
  for (const cell of shots) {
    if (cell < 0 || cell >= CELLS || shot[cell] === 1) continue
    const open: number[] = []
    for (let c = 0; c < CELLS; c++) if (hitCell[c] === 1 && !sunk.some((p) => p && shipCells(p).includes(c))) open.push(c)
    const post = posterior(miss, hitCell, open, sunk, rng)
    // No sample fitted (a very rare board): share the unhit ship squares evenly over the unshot squares, which claims no skill and no luck.
    const p = post[cell]! >= 0 ? post[cell]! : target.reduce((a, q, i) => a + (sunk[i] ? 0 : q.length), 0) / (CELLS - shot.reduce((a, b) => a + b, 0))
    expected += p
    variance += p * (1 - p)
    scored++
    shot[cell] = 1
    const ship = target.find((q) => shipCells(q).includes(cell))
    if (!ship) {
      miss[cell] = 1
      continue
    }
    hits++
    hitCell[cell] = 1
    if (shipCells(ship).every((c) => hitCell[c] === 1)) sunk[ship.id] = ship
  }
  return { shots: scored, hits, expected, variance }
}

export type LuckVerdict = 'lucky' | 'unlucky' | 'about even'

/** How many standard deviations of chance the player sits above (lucky) or below (unlucky) the hits their choices should have scored. */
export const LUCK_BAND = 1

export function luckVerdict(score: Pick<LuckScore, 'hits' | 'expected' | 'variance'>): LuckVerdict {
  const z = (score.hits - score.expected) / Math.sqrt(Math.max(score.variance, 0.25))
  if (z > LUCK_BAND) return 'lucky'
  if (z < -LUCK_BAND) return 'unlucky'
  return 'about even'
}

export interface LuckInput {
  won: boolean
  /** Shots the winner fired. */
  winnerShots: number
  /** Ships the player sank. */
  found: number
  score: LuckScore
  opponent: string
  /** Word the line about "the player" for a stranger. */
  third?: boolean
}

/** The luck line (design spec 2.6): the hits scored against the hits the chosen squares should have scored. Always ends with the verdict clause. */
export function fleetLuckLine(i: LuckInput): string {
  const verdict = luckVerdict(i.score)
  const You = i.third ? 'The player' : 'You'
  const head = i.won ? `${You} sank all five in ${i.winnerShots} shots.` : `${i.opponent} sank ${i.third ? "the player's" : 'your'} fleet in ${i.winnerShots} shots.`
  const found = i.won ? '' : ` (${COUNT_WORDS[i.found] ?? i.found} ${i.found === 1 ? 'ship' : 'ships'} found)`
  const tail = verdict === 'lucky' && !i.won ? `${You} ran lucky, and still lost on the chase.` : `${You} ran ${verdict}.`
  return `${head} ${i.third ? 'They' : 'You'} hit ${i.score.hits} of ${i.score.shots} shots${found}; those squares should hit about ${Math.round(i.score.expected)}. ${tail}`
}
