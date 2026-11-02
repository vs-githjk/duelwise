import type { GameCore, Result, Seat } from '../../types'
import type { GameId } from '../../product'
import { hashState } from '../../hash'
import { makeRng } from '../../rng'

/**
 * Twelve Yards: a penalty shootout with simultaneous hidden choices. Each tick is one kick:
 * the shooter picks a zone and the keeper picks a dive zone at the same time, neither sees the
 * other's pick, and a seeded roll decides the goal from a fixed table. Seat 0 shoots first and
 * the roles swap every kick. Five kicks each, an early end when a lead cannot be caught, then
 * sudden death by whole rounds.
 *
 * State is { seed, kicks } and everything else derives from it. The roll belongs to the kick
 * index, so there is no generator state to carry or hash.
 */

export const KICKS = 5
export const EXTRA_ROUNDS = 12

/** Left, Middle, Right as seen from the spot, in both roles. */
export type Zone = 0 | 1 | 2

/** Goal chance in per mille, [shooter zone][keeper dive zone]. Same side is the keeper's best case; the middle is a bluff. */
export const GOAL_PER_MILLE: readonly (readonly number[])[] = [
  [100, 920, 980],
  [700, 50, 700],
  [980, 920, 100],
]

export interface Kick {
  kicker: Seat
  zone: Zone
  dive: Zone
  goal: boolean
}

export interface PenaltyState {
  seed: number
  kicks: Kick[]
}

export interface KickView {
  byMe: boolean
  zone: Zone
  dive: Zone
  /** Save when the zones match and no goal, otherwise wide. */
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

const ID = 'penalty' as GameId
const MAX_KICKS = 2 * (KICKS + EXTRA_ROUNDS)

function isZone(n: unknown): n is Zone {
  return n === 0 || n === 1 || n === 2
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

function roll(seed: number, index: number, zone: Zone, dive: Zone): boolean {
  return makeRng((seed ^ Math.imul(index + 1, 0x85ebca6b)) | 0).int(1000) < GOAL_PER_MILLE[zone][dive]
}

export const penaltyCore: GameCore<PenaltyState, Zone, PenaltyObs> = {
  id: ID,
  version: 'penalty-1',
  init(seed) {
    return { seed: seed | 0, kicks: [] }
  },
  toAct: (s) => (isOver(s.kicks) ? [] : [0, 1]),
  legal: (s, _seat) => (isOver(s.kicks) ? [] : [0, 1, 2]),
  step(s, actions) {
    if (isOver(s.kicks)) throw new Error('penalty: the shootout is over')
    for (const seat of [0, 1] as const) {
      const a = actions[seat]
      if (a === null || a === undefined) throw new Error('penalty: missing action for seat ' + seat)
      if (!isZone(a)) throw new Error('penalty: bad zone ' + String(a))
    }
    const index = s.kicks.length
    const kicker = kickerOf(index)
    const zone = actions[kicker] as Zone
    const dive = actions[(1 - kicker) as Seat] as Zone
    const kick: Kick = { kicker, zone, dive, goal: roll(s.seed, index, zone, dive) }
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
        outcome: k.goal ? 'goal' : k.zone === k.dive ? 'save' : 'wide',
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
