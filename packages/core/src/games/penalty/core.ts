import type { GameCore, Result, Seat } from '../../types'
import type { GameId } from '../../product'
import { hashState } from '../../hash'
import { makeRng } from '../../rng'

/**
 * Twelve Yards: a penalty shootout with simultaneous hidden choices. Each tick is one kick: the shooter picks one of nine zones
 * of the goal and the keeper picks one of five dives at the same time, neither sees the other's pick, and one seeded roll decides
 * goal, save or wide from two fixed tables. Seat 0 shoots first and the roles swap every kick. Five kicks each, an early end when
 * a lead cannot be caught, then sudden death by whole rounds.
 *
 * State is { seed, kicks } and everything else derives from it. The roll belongs to the kick index, so there is no generator
 * state to carry or hash.
 */

export const KICKS = 5
export const EXTRA_ROUNDS = 12

/** A goal zone as seen from the spot, row * 3 + column: 0 top left, 1 top middle, 2 top right, 3 left, 4 straight down the middle, 5 right, 6 bottom left, 7 bottom middle, 8 bottom right. */
export type Zone = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
/** A keeper's dive: 0 left high, 1 left low, 2 stay, 3 right high, 4 right low. A dive is a shared action code, so it fits in the same 0..8 range. */
export type Dive = 0 | 1 | 2 | 3 | 4

export const ZONES: readonly Zone[] = [0, 1, 2, 3, 4, 5, 6, 7, 8]
export const DIVES: readonly Dive[] = [0, 1, 2, 3, 4]

/** Chance the shot is on target, per mille, by zone. Top corners miss most, bottom corners least. */
export const ON_TARGET_PER_MILLE: readonly number[] = [760, 760, 760, 800, 780, 800, 930, 800, 930]

/**
 * Goal chance in per mille, [shooter zone][dive]. Never above the zone's on-target chance, so one roll gives all three outcomes.
 * A top corner saved is 340, a bottom corner 120: hard to reach, easier to miss. Down the middle is the bluff: 780 past a keeper
 * who goes, 30 into one who stays. The four edge cells are the cheap looking shots two dives or the stay already cover.
 */
export const GOAL_PER_MILLE: readonly (readonly number[])[] = [
  [340, 760, 760, 760, 760],
  [480, 760, 220, 480, 760],
  [760, 760, 760, 340, 760],
  [200, 200, 760, 800, 800],
  [780, 780, 30, 780, 780],
  [800, 800, 760, 200, 200],
  [780, 120, 930, 930, 930],
  [800, 480, 120, 800, 480],
  [930, 930, 930, 780, 120],
]

export interface Kick {
  kicker: Seat
  zone: Zone
  dive: Dive
  goal: boolean
  /** A goal is always on target; on target with no goal is a save, off target is wide. */
  onTarget: boolean
}

export interface PenaltyState {
  seed: number
  kicks: Kick[]
}

export interface KickView {
  byMe: boolean
  zone: Zone
  dive: Dive
  outcome: 'goal' | 'save' | 'wide'
}

export interface PenaltyObs {
  seat: Seat
  /** Null when the shootout is over. */
  role: 'shooter' | 'keeper' | null
  /** 1-based; the last round played once over. */
  round: number
  sudden: boolean
  /** Mine, theirs. */
  goals: [number, number]
  /** Kicks taken by me, by them. */
  taken: [number, number]
  /** Finished kicks only, nothing about the seed or any roll. */
  kicks: KickView[]
  over: boolean
}

const ID: GameId = 'penalty'
const MAX_KICKS = 2 * (KICKS + EXTRA_ROUNDS)

function isZone(n: unknown): n is Zone {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 8
}

function isDive(n: unknown): n is Dive {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4
}

function tally(kicks: Kick[]): { goals: [number, number]; taken: [number, number] } {
  const goals: [number, number] = [0, 0]
  const taken: [number, number] = [0, 0]
  for (const k of kicks) {
    taken[k.kicker]++
    if (k.goal) goals[k.kicker]++
  }
  return { goals, taken }
}

function isOver(kicks: Kick[]): boolean {
  const n = kicks.length
  const { goals, taken } = tally(kicks)
  if (n <= 2 * KICKS) {
    const left0 = KICKS - taken[0]
    const left1 = KICKS - taken[1]
    return goals[0] > goals[1] + left1 || goals[1] > goals[0] + left0
  }
  if (n % 2 !== 0) return false
  return goals[0] !== goals[1] || n >= MAX_KICKS
}

/** The seat that shoots kick number `index` (0-based): seat 0 first, swapping every kick. */
function kickerOf(index: number): Seat {
  return (index % 2) as Seat
}

function roll(seed: number, index: number): number {
  return makeRng((seed ^ Math.imul(index + 1, 0x85ebca6b)) | 0).int(1000)
}

export const penaltyCore: GameCore<PenaltyState, Zone, PenaltyObs> = {
  id: ID,
  version: 'penalty-2',
  init(seed) {
    return { seed: seed | 0, kicks: [] }
  },
  toAct: (s) => (isOver(s.kicks) ? [] : [0, 1]),
  legal: (s, seat) => {
    if (isOver(s.kicks)) return []
    return [...(kickerOf(s.kicks.length) === seat ? ZONES : DIVES)]
  },
  step(s, actions) {
    if (isOver(s.kicks)) throw new Error('penalty: the shootout is over')
    const index = s.kicks.length
    const kicker = kickerOf(index)
    for (const seat of [0, 1] as const) {
      const a = actions[seat]
      if (a === null || a === undefined) throw new Error('penalty: missing action for seat ' + seat)
      if (seat === kicker ? !isZone(a) : !isDive(a)) throw new Error(`penalty: bad ${seat === kicker ? 'zone' : 'dive'} ${String(a)}`)
    }
    const zone = actions[kicker] as Zone
    const dive = actions[(1 - kicker) as Seat] as Dive
    const r = roll(s.seed, index)
    const kick: Kick = { kicker, zone, dive, goal: r < GOAL_PER_MILLE[zone]![dive]!, onTarget: r < ON_TARGET_PER_MILLE[zone]! }
    return { seed: s.seed, kicks: [...s.kicks, kick] }
  },
  terminal: (s) => isOver(s.kicks),
  result(s): Result | null {
    if (!isOver(s.kicks)) return null
    const { goals } = tally(s.kicks)
    if (goals[0] === goals[1]) return { winner: null, score: [goals[0], goals[1]], reason: 'level after sudden death' }
    return { winner: goals[0] > goals[1] ? 0 : 1, score: [goals[0], goals[1]], reason: 'more goals' }
  },
  observe(s, seat) {
    const over = isOver(s.kicks)
    const n = s.kicks.length
    const { goals, taken } = tally(s.kicks)
    const them = (1 - seat) as Seat
    const round = over ? Math.max(1, Math.floor((n - 1) / 2) + 1) : Math.floor(n / 2) + 1
    return {
      seat,
      role: over ? null : kickerOf(n) === seat ? 'shooter' : 'keeper',
      round,
      sudden: round > KICKS,
      goals: [goals[seat], goals[them]],
      taken: [taken[seat], taken[them]],
      kicks: s.kicks.map((k) => ({
        byMe: k.kicker === seat,
        zone: k.zone,
        dive: k.dive,
        outcome: k.goal ? 'goal' : k.onTarget ? 'save' : 'wide',
      })),
      over,
    }
  },
  hash: (s) => hashState(s),
  encodeAction(a) {
    if (!isZone(a)) throw new Error('penalty: bad zone ' + String(a))
    return a
  },
  decodeAction(n) {
    if (!isZone(n)) throw new Error('penalty: bad action code ' + String(n))
    return n
  },
}

/** Factory form for the measurement harness, which builds a core from a module path. */
export function createPenaltyCore() {
  return penaltyCore
}
