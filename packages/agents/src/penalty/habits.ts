import { GOAL_PER_MILLE } from '@duelwise/core/src/games/penalty/core'
import type { KickView } from '@duelwise/core/src/games/penalty/core'
import { EQ_KEEPER, EQ_SHOOTER } from './levels'

export type Dist = number[]

export const ZONE_COUNT = 9
export const DIVE_COUNT = 5
export const CORNERS = [0, 2, 6, 8] as const
export const SIDE_DIVES = [0, 1, 3, 4] as const

/** Goal chance [shooter zone][dive]. */
const M: number[][] = GOAL_PER_MILLE.map((row) => row.map((x) => x / 1000))

/** The same zone on the other side of the goal: left and right swap, the row stays. */
export function mirrorZone(z: number): number {
  return z - (z % 3) + (2 - (z % 3))
}

/** The same dive to the other side; a stay is its own mirror. */
export function mirrorDive(d: number): number {
  return d === 2 ? 2 : d < 2 ? d + 3 : d - 3
}

/** 0 left, 1 stay, 2 right. */
export function sideOfDive(d: number): 0 | 1 | 2 {
  return d === 2 ? 1 : d < 2 ? 0 : 2
}

function indexOfMin(v: readonly number[]): number {
  let best = 0
  for (let i = 1; i < v.length; i++) if (v[i]! < v[best]!) best = i
  return best
}

/** The dive that gives up the fewest goals to this zone. */
export const COVER: readonly number[] = M.map((row) => indexOfMin(row))

/** What each side did, in kick order. Built from finished kicks only. */
export interface Streams {
  /** Zones the opponent shot to (when I dived). */
  oppKicks: number[]
  /** Dives I picked against those. Same length as oppKicks. */
  myDives: number[]
  /** Zones I shot to. */
  myKicks: number[]
  /** Dives the opponent picked against those. Same length as myKicks. */
  oppDives: number[]
}

export function streamsOf(kicks: readonly KickView[]): Streams {
  const s: Streams = { oppKicks: [], myDives: [], myKicks: [], oppDives: [] }
  for (const k of kicks) {
    if (k.byMe) {
      s.myKicks.push(k.zone)
      s.oppDives.push(k.dive)
    } else {
      s.oppKicks.push(k.zone)
      s.myDives.push(k.dive)
    }
  }
  return s
}

export function one(i: number, n: number): Dist {
  const d: Dist = new Array<number>(n).fill(0)
  d[i] = 1
  return d
}

/** w * a + (1 - w) * b. */
export function mix(a: readonly number[], b: readonly number[], w: number): Dist {
  return a.map((x, i) => w * x + (1 - w) * b[i]!)
}

/** Holds every entry at `min` or more and rescales the others, so the total is 1 and the floor is exact: a share the rescale would push under `min` is held there too. */
export function floored(d: readonly number[], min: number): Dist {
  const held = d.map((x) => x < min)
  for (;;) {
    const left = 1 - min * held.filter(Boolean).length
    const free = d.reduce((a, x, i) => (held[i] ? a : a + x), 0)
    const under = d.findIndex((x, i) => !held[i] && (x * left) / free < min)
    if (under < 0) return d.map((x, i) => (held[i] ? min : (x * left) / free))
    held[under] = true
  }
}

/** Left and right count as tied when their values are within this; the caller's side then decides (the table is mirror symmetric, so the gap is noise). */
const SIDE_TIE = 0.002

/** The dive that gives up the fewest goals against a predicted shooter mix; a left/right near tie goes to `side`, other ties to the lowest dive. */
export function bestKeeper(p: readonly number[], side: 0 | 2 = 0): Dist {
  const vals: number[] = []
  for (let d = 0; d < DIVE_COUNT; d++) vals.push(p.reduce((a, q, z) => a + q * M[z]![d]!, 0))
  let best = indexOfMin(vals)
  const other = mirrorDive(best)
  if (best !== other && Math.abs(vals[best]! - vals[other]!) <= SIDE_TIE) best = sideOfDive(best) === side ? best : other
  return one(best, DIVE_COUNT)
}

/** The zone that scores most against a predicted keeper mix; a left/right near tie goes to `side`, other ties to the lowest zone. */
export function bestShooter(p: readonly number[], side: 0 | 2 = 0): Dist {
  const vals: number[] = M.map((row) => row.reduce((a, g, d) => a + g * p[d]!, 0))
  let best = 0
  for (let z = 1; z < ZONE_COUNT; z++) if (vals[z]! > vals[best]!) best = z
  const other = mirrorZone(best)
  if (best !== other && Math.abs(vals[best]! - vals[other]!) <= SIDE_TIE) best = best % 3 === side ? best : other
  return one(best, ZONE_COUNT)
}

type Hypothesis = (prev: number[], mine: number[]) => readonly number[]

const SOFT = 0.1

function softOf(d: readonly number[]): Dist {
  return d.map((x) => x * (1 - SOFT) + SOFT / d.length)
}

/**
 * Eleven habit shapes for one stream of choices (the opponent's kicks, or their dives). Each gives the next choice's distribution
 * from the stream so far (`prev`) and from what I did alongside it (`mine`). Index 0 is the equilibrium. `echo` turns one of my
 * choices into the opponent's choices that follow it, for the "copies my last" and "avoids my last" shapes.
 */
function habitShapes(eq: readonly number[], favourites: readonly number[], mirror: (x: number) => number, echo: (m: number) => Dist): Hypothesis[] {
  const n = eq.length
  const soft = (i: number) => softOf(one(i, n))
  return [
    () => eq,
    ...favourites.map((f): Hypothesis => () => soft(f)),
    (p) => (p.length ? soft(p[p.length - 1]!) : eq), // repeat
    (p) => (p.length >= 2 ? soft(p[p.length - 2]!) : eq), // alternate
    (p) => (p.length ? soft(mirror(p[p.length - 1]!)) : eq), // mirror
    (_p, m) => (m.length ? softOf(echo(m[m.length - 1]!)) : eq), // copies my last
    (_p, m) => {
      // avoids my last
      if (!m.length) return eq
      const away = echo(m[m.length - 1]!).map((x): number => (x > 0 ? 0 : 1))
      const sum = away.reduce((a, b) => a + b, 0)
      return softOf(away.map((x) => x / sum))
    },
  ]
}

/** The zones this dive is the best answer to, shared evenly: what a shooter who copies my dive is drawn to. */
function zonesOfDive(dive: number): Dist {
  const hits = COVER.map((d): number => (d === dive ? 1 : 0))
  const sum = hits.reduce((a, b) => a + b, 0)
  return sum ? hits.map((x) => x / sum) : new Array<number>(ZONE_COUNT).fill(1 / ZONE_COUNT)
}

/** Shapes for a stream of kicks (the shooter's choices, read beside my dives) and for a stream of dives (read beside my kicks). */
export const KICK_HABITS: Hypothesis[] = habitShapes(EQ_SHOOTER, [...CORNERS, 4], mirrorZone, zonesOfDive)
export const DIVE_HABITS: Hypothesis[] = habitShapes(EQ_KEEPER, [0, 1, 2, 3, 4], mirrorDive, (z) => one(COVER[z]!, DIVE_COUNT))

/** Equilibrium 0.5, the others share the rest. */
function prior(n: number): number[] {
  const p: number[] = new Array<number>(n).fill(0.5 / (n - 1))
  p[0] = 0.5
  return p
}

/** Bayes over the habit shapes: the predicted next choice, and the posterior that this stream is just equilibrium play. */
export function predict(shapes: Hypothesis[], observed: number[], mine: number[]): { out: Dist; eqP: number } {
  const post = prior(shapes.length)
  for (let t = 0; t < observed.length; t++) {
    let sum = 0
    for (let h = 0; h < shapes.length; h++) {
      post[h]! *= shapes[h]!(observed.slice(0, t), mine.slice(0, t))[observed[t]!]! + 1e-9
      sum += post[h]!
    }
    for (let h = 0; h < shapes.length; h++) post[h]! /= sum
  }
  const first = shapes[0]!(observed, mine)
  const out: Dist = new Array<number>(first.length).fill(0)
  for (let h = 0; h < shapes.length; h++) {
    const d = shapes[h]!(observed, mine)
    for (let i = 0; i < out.length; i++) out[i]! += post[h]! * d[i]!
  }
  return { out, eqP: post[0]! }
}
