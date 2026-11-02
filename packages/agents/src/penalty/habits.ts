import { GOAL_PER_MILLE } from '@duelwise/core/src/games/penalty/core'
import type { KickView } from '@duelwise/core/src/games/penalty/core'
import { EQ_KEEPER, EQ_SHOOTER } from './levels'

export type Dist = [number, number, number]

/** Goal chance [shooter zone][keeper dive zone]. */
const M: number[][] = GOAL_PER_MILLE.map((row) => row.map((x) => x / 1000))

/** What each side did, in kick order. Built from finished kicks only. */
export interface Streams {
  /** Zones the opponent shot to (when I dived). */
  oppKicks: number[]
  /** Zones I dived to against those. Same length as oppKicks. */
  myDives: number[]
  /** Zones I shot to. */
  myKicks: number[]
  /** Zones the opponent dived to against those. Same length as myKicks. */
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

export function one(i: number): Dist {
  const d: Dist = [0, 0, 0]
  d[i] = 1
  return d
}

/** w * a + (1 - w) * b. */
export function mix(a: readonly number[], b: readonly number[], w: number): Dist {
  return [w * a[0]! + (1 - w) * b[0]!, w * a[1]! + (1 - w) * b[1]!, w * a[2]! + (1 - w) * b[2]!]
}

/** The dive that gives up the fewest goals against a predicted shooter mix; ties go to the lowest zone. */
export function bestKeeper(p: readonly number[]): Dist {
  let best = 0
  let bestV = Infinity
  for (let k = 0; k < 3; k++) {
    const v = p[0]! * M[0]![k]! + p[1]! * M[1]![k]! + p[2]! * M[2]![k]!
    if (v < bestV) {
      bestV = v
      best = k
    }
  }
  return one(best)
}

/** The zone that scores most against a predicted keeper mix; ties go to the lowest zone. */
export function bestShooter(p: readonly number[]): Dist {
  let best = 0
  let bestV = -Infinity
  for (let s = 0; s < 3; s++) {
    const v = p[0]! * M[s]![0]! + p[1]! * M[s]![1]! + p[2]! * M[s]![2]!
    if (v > bestV) {
      bestV = v
      best = s
    }
  }
  return one(best)
}

type Hypothesis = (prev: number[], mine: number[]) => readonly number[]

const SOFT = 0.1

function soft(i: number): Dist {
  const d: Dist = [SOFT / 2, SOFT / 2, SOFT / 2]
  d[i] = 1 - SOFT
  return d
}

/**
 * Nine habit shapes for one stream of choices (the opponent's kicks, or their dives). Each gives the next choice's
 * distribution from the stream so far (`prev`) and from what I did alongside it (`mine`). Index 0 is the equilibrium.
 */
function habitShapes(eq: readonly number[]): Hypothesis[] {
  return [
    () => eq,
    () => soft(0), // favourite left
    () => soft(1), // favourite middle
    () => soft(2), // favourite right
    (p) => (p.length ? soft(p[p.length - 1]!) : eq), // repeat
    (p) => (p.length >= 2 ? soft(p[p.length - 2]!) : eq), // alternate
    (p) => (p.length ? soft(2 - p[p.length - 1]!) : eq), // mirror
    (_p, m) => (m.length ? soft(m[m.length - 1]!) : eq), // copies my last
    (_p, m) => {
      // avoids my last
      if (!m.length) return eq
      const d = [1, 1, 1]
      d[m[m.length - 1]!] = 0
      return d.map((x) => (x / 2) * (1 - SOFT) + SOFT / 3)
    },
  ]
}

/** Shapes for a stream of kicks (the shooter's choices) and for a stream of dives. */
export const KICK_HABITS: Hypothesis[] = habitShapes(EQ_SHOOTER)
export const DIVE_HABITS: Hypothesis[] = habitShapes(EQ_KEEPER)

/** Equilibrium 0.5, the other eight share the rest. */
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
  const out: Dist = [0, 0, 0]
  for (let h = 0; h < shapes.length; h++) {
    const d = shapes[h]!(observed, mine)
    for (let i = 0; i < 3; i++) out[i]! += post[h]! * d[i]!
  }
  return { out, eqP: post[0]! }
}
