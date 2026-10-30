import type { Rng } from '../../types'
import { makeRng } from '../../rng'
import { cardRank, cardSuit } from './cards'
import { rank7 } from './evaluator'
import { BIG_BLIND, STACK } from './match'

// Card and action abstraction shared by training (cfr-main) and play (the browser agent).
//
// Cards. Preflop has 169 lossless classes (pairs, suited, offsuit). Flop, turn and river hands
// are put into equal-mass equity buckets. Equity is the chance to win at showdown against a
// uniformly random opponent hand (a tie counts half):
//   river: exact, all 990 opponent holdings.
//   turn: seeded Monte Carlo over opponent hand and the river card, so draws are valued by their
//         chance to complete (not by the made hand they hold now).
//   flop: seeded Monte Carlo over opponent hand and both future cards.
//   Both Monte Carlo streets take the seed from the suit-canonical (hand, board), so isomorphic
//   spots always share a bucket.
// Bucket cut points are quantiles of the equity distribution over seeded random deals, computed
// once per configuration (computeThresholds) and stored in the strategy table header.

export interface AbstractionConfig {
  name: string
  /** Buckets on the flop, turn and river. */
  buckets: [number, number, number]
}

export const COARSE: AbstractionConfig = { name: 'coarse', buckets: [20, 20, 20] }
export const FINE: AbstractionConfig = { name: 'fine', buckets: [50, 50, 50] }
export const PREFLOP_CLASSES = 169
export const FLOP_SAMPLES = 800
export const TURN_SAMPLES = 600
/** Names the equity definition behind every bucket. Change it whenever streetEquity changes; thresholds, checkpoints and tables carry it. */
export const EQUITY_VERSION = 'turn-mc-600/flop-mc-800/river-exact'

/** Loaders call this on every thresholds, checkpoint and table file they read. */
export function assertEquityVersion(what: string, found: unknown): void {
  if (found !== EQUITY_VERSION) throw new Error(`${what}: built with equity definition ${String(found)}, this code uses ${EQUITY_VERSION}; rebuild it with the current code`)
}

// Action ids shared by training, the table and the agent.
export const FOLD = 0
export const CALL = 1
export const HALF = 2
export const POT = 3
export const ALLIN = 4
export const ACTION_WIDTH = 5
/** Raise fractions of (pot + amount to call) for HALF and POT. */
export const RAISE_FRACTIONS: Record<number, number> = { [HALF]: 0.5, [POT]: 1 }

/** 0..168: pairs 0..12 (by rank), suited 13..90, offsuit 91..168. */
export function preflopClass(c1: number, c2: number): number {
  let hi = cardRank(c1)
  let lo = cardRank(c2)
  if (lo > hi) [hi, lo] = [lo, hi]
  if (hi === lo) return hi
  const tri = (hi * (hi - 1)) / 2 + lo
  return (cardSuit(c1) === cardSuit(c2) ? 13 : 91) + tri
}

/** Share of showdowns won against a uniformly random hand: exact for 4 or 5 board cards. */
export function exactEquity(hole: ArrayLike<number>, board: ArrayLike<number>): number {
  if (board.length !== 4 && board.length !== 5) throw new Error('exactEquity needs 4 or 5 board cards')
  const dead = new Uint8Array(52)
  for (let i = 0; i < 2; i++) dead[hole[i]!] = 1
  for (let i = 0; i < board.length; i++) dead[board[i]!] = 1
  const live: number[] = []
  for (let c = 0; c < 52; c++) if (!dead[c]) live.push(c)
  const mine = rank7([hole[0]!, hole[1]!, ...Array.from(board)])
  const cards = new Array<number>(board.length + 2)
  for (let i = 0; i < board.length; i++) cards[i + 2] = board[i]!
  let score = 0
  let n = 0
  for (let i = 0; i < live.length; i++) {
    cards[0] = live[i]!
    for (let j = i + 1; j < live.length; j++) {
      cards[1] = live[j]!
      const theirs = rank7(cards)
      score += mine > theirs ? 1 : mine === theirs ? 0.5 : 0
      n++
    }
  }
  return score / n
}

const SUIT_PERMS: number[][] = (() => {
  const out: number[][] = []
  const rec = (cur: number[], rest: number[]): void => {
    if (rest.length === 0) {
      out.push(cur)
      return
    }
    for (let i = 0; i < rest.length; i++) rec([...cur, rest[i]!], rest.filter((_, k) => k !== i))
  }
  rec([], [0, 1, 2, 3])
  return out
})()

/**
 * The suit-canonical form of a spot: the relabelling of suits that gives the smallest 32-bit key,
 * with hole and board cards sorted. Spots that differ only by suit names return identical output.
 */
export function canonicalSpot(hole: ArrayLike<number>, board: ArrayLike<number>): { key: number; hole: number[]; board: number[] } {
  let best: { key: number; hole: number[]; board: number[] } | null = null
  for (const perm of SUIT_PERMS) {
    const map = (c: number): number => ((c >> 2) << 2) | perm[c & 3]!
    const h = [map(hole[0]!), map(hole[1]!)].sort((a, b) => a - b)
    const b = Array.from(board, map).sort((a, c) => a - c)
    let x = 0x811c9dc5
    for (const c of h) x = Math.imul(x ^ (c + 1), 0x01000193)
    x = Math.imul(x ^ 0xff, 0x01000193)
    for (const c of b) x = Math.imul(x ^ (c + 1), 0x01000193)
    x >>>= 0
    const better = !best || x < best.key || (x === best.key && lexLess([...h, ...b], [...best.hole, ...best.board]))
    if (better) best = { key: x, hole: h, board: b }
  }
  return best!
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}

/** A 32-bit key that is equal for hands and boards that differ only by a relabelling of suits. */
export function canonicalKey(hole: ArrayLike<number>, board: ArrayLike<number>): number {
  return canonicalSpot(hole, board).key
}

/**
 * Seeded Monte Carlo showdown equity for a three or four card board: the opponent hand and every
 * missing board card are random. The seed is taken from the suit-canonical spot.
 */
function sampledEquity(hole0: ArrayLike<number>, board0: ArrayLike<number>, samples: number, seed?: number): number {
  // Sample on the suit-canonical cards so isomorphic spots draw identical runouts.
  const { key, hole, board } = canonicalSpot(hole0, board0)
  const nb = board.length
  const rng = makeRng(seed ?? key)
  const dead = new Uint8Array(52)
  for (let i = 0; i < 2; i++) dead[hole[i]!] = 1
  for (let i = 0; i < nb; i++) dead[board[i]!] = 1
  const live: number[] = []
  for (let c = 0; c < 52; c++) if (!dead[c]) live.push(c)
  const mine = [hole[0]!, hole[1]!, 0, 0, 0, 0, 0]
  const theirs = [0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < nb; i++) mine[2 + i] = theirs[2 + i] = board[i]!
  const draw = 2 + (5 - nb)
  let score = 0
  for (let k = 0; k < samples; k++) {
    // Partial Fisher-Yates: the opponent pair plus the missing board cards, all distinct.
    for (let i = 0; i < draw; i++) {
      const j = i + rng.int(live.length - i)
      const t = live[i]!
      live[i] = live[j]!
      live[j] = t
    }
    theirs[0] = live[0]!
    theirs[1] = live[1]!
    for (let i = 0; i < 5 - nb; i++) mine[2 + nb + i] = theirs[2 + nb + i] = live[2 + i]!
    const a = rank7(mine)
    const b = rank7(theirs)
    score += a > b ? 1 : a === b ? 0.5 : 0
  }
  return score / samples
}

/** Seeded Monte Carlo equity for a three-card board (opponent hand and both future cards random). */
export function flopEquity(hole: ArrayLike<number>, board: ArrayLike<number>, samples = FLOP_SAMPLES, seed?: number): number {
  if (board.length !== 3) throw new Error('flopEquity needs 3 board cards')
  return sampledEquity(hole, board, samples, seed)
}

/** Seeded Monte Carlo equity for a four-card board (opponent hand and the river card random). */
export function turnEquity(hole: ArrayLike<number>, board: ArrayLike<number>, samples = TURN_SAMPLES, seed?: number): number {
  if (board.length !== 4) throw new Error('turnEquity needs 4 board cards')
  return sampledEquity(hole, board, samples, seed)
}

/** Equity used for bucketing: street 1 flop and 2 turn (Monte Carlo), 3 river (exact). */
export function streetEquity(street: 1 | 2 | 3, hole: ArrayLike<number>, board: ArrayLike<number>, flopSamples = FLOP_SAMPLES): number {
  if (street === 1) return flopEquity(hole, board, flopSamples)
  if (street === 2) return turnEquity(hole, board, Math.min(TURN_SAMPLES, flopSamples))
  return exactEquity(hole, board)
}

function randomSpot(street: 1 | 2 | 3, rng: Rng): { hole: number[]; board: number[] } {
  const deck = Array.from({ length: 52 }, (_, i) => i)
  const n = 2 + 2 + street + 2 // hole, board; the extra two are not used
  for (let i = 0; i < n && i < 52; i++) {
    const j = i + rng.int(52 - i)
    const t = deck[i]!
    deck[i] = deck[j]!
    deck[j] = t
  }
  return { hole: [deck[0]!, deck[1]!], board: deck.slice(2, 2 + 2 + street) }
}

export interface ThresholdOptions {
  seed?: number
  /** Random spots sampled per street. */
  samples?: [number, number, number]
  flopSamples?: number
}

/** Equal-mass cut points: `buckets - 1` ascending equity values per street. */
export function computeThresholds(config: AbstractionConfig, opts: ThresholdOptions = {}): number[][] {
  const seed = opts.seed ?? 20261021
  const samples = opts.samples ?? [6000, 20000, 20000]
  const out: number[][] = []
  for (let street = 1 as 1 | 2 | 3; street <= 3; street = (street + 1) as 1 | 2 | 3) {
    const rng = makeRng(seed + street)
    const n = samples[street - 1]!
    const eq = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const spot = randomSpot(street, rng)
      eq[i] = streetEquity(street, spot.hole, spot.board, opts.flopSamples)
    }
    eq.sort()
    const b = config.buckets[street - 1]!
    const cuts: number[] = []
    for (let k = 1; k < b; k++) cuts.push(eq[Math.min(n - 1, Math.floor((k * n) / b))]!)
    out.push(cuts)
  }
  return out
}

export class Abstraction {
  constructor(readonly config: AbstractionConfig, readonly thresholds: number[][]) {
    for (let i = 0; i < 3; i++) {
      if (thresholds[i]?.length !== config.buckets[i]! - 1) throw new Error('abstraction: thresholds do not match the bucket counts')
    }
  }

  bucketOfEquity(street: 1 | 2 | 3, equity: number): number {
    const cuts = this.thresholds[street - 1]!
    let lo = 0
    let hi = cuts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cuts[mid]! <= equity) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Preflop class for street 0, an equity bucket for streets 1 to 3. */
  bucket(street: 0 | 1 | 2 | 3, hole: ArrayLike<number>, board: ArrayLike<number>): number {
    if (street === 0) return preflopClass(hole[0]!, hole[1]!)
    return this.bucketOfEquity(street, streetEquity(street, hole, board))
  }

  /** Number of distinct values `bucket` returns on a street. */
  size(street: 0 | 1 | 2 | 3): number {
    return street === 0 ? PREFLOP_CLASSES : this.config.buckets[street - 1]!
  }
}

// ---------- actions ----------

/** The acting seat's betting spot; chip amounts are totals for the street unless named total. */
export interface BetSpot {
  bet: number
  oppBet: number
  /** Chips put in this hand so far. */
  total: number
  oppTotal: number
  /** Legal raise-to range; minTo > maxTo means the seat cannot raise. */
  minTo: number
  maxTo: number
}

export interface AbstractAction {
  id: number
  /** Raise-to amount for raise ids; for FOLD and CALL the amount the street total ends at (call) or -1 (fold). */
  to: number
}

/** The abstract options at a spot: fold (when facing a bet), call, half pot, pot, all in. */
export function abstractActions(spot: BetSpot): AbstractAction[] {
  const out: AbstractAction[] = []
  const toCall = spot.oppBet - spot.bet
  if (toCall > 0) out.push({ id: FOLD, to: -1 })
  out.push({ id: CALL, to: Math.min(spot.oppBet, spot.bet + (STACK - spot.total)) })
  if (spot.minTo > spot.maxTo) return out
  const pot = spot.total + spot.oppTotal
  let last = -1
  for (const id of [HALF, POT]) {
    const raw = spot.oppBet + Math.round(RAISE_FRACTIONS[id]! * (pot + toCall))
    const to = Math.max(raw, spot.minTo)
    if (to >= spot.maxTo || to === last) continue
    out.push({ id, to })
    last = to
  }
  out.push({ id: ALLIN, to: spot.maxTo })
  return out
}

/** Size of a raise to `to` as a fraction of (pot + amount to call). */
export function raiseFraction(spot: BetSpot, to: number): number {
  const toCall = spot.oppBet - spot.bet
  return (to - spot.oppBet) / (spot.total + spot.oppTotal + toCall)
}

// ---------- infoset keys ----------

export interface KeyParts {
  street: 0 | 1 | 2 | 3
  bucket: number
  isButton: boolean
  /** Chips each seat had in at the start of the street. */
  prior: number
  bet: number
  oppBet: number
}

/**
 * The infoset key. Betting history is not kept: the street, position, chips in before the
 * street and both street bets say what the acting seat can do and what the pot is. Different
 * histories with the same chips share a key (imperfect recall by design).
 */
export function infoKey(k: KeyParts): string {
  return k.street + ':' + k.bucket + ':' + (k.isButton ? 1 : 0) + ':' + k.prior + ':' + k.bet + ':' + k.oppBet
}

export function parseInfoKey(key: string): KeyParts {
  const p = key.split(':').map(Number)
  return { street: p[0] as 0 | 1 | 2 | 3, bucket: p[1]!, isButton: p[2] === 1, prior: p[3]!, bet: p[4]!, oppBet: p[5]! }
}

/** Counts the betting states (street, position, chips before the street, both bets) of the abstract tree. */
export function enumerateBettingStates(): Array<{ street: 0 | 1 | 2 | 3; isButton: boolean; prior: number; bet: number; oppBet: number }> {
  const seen = new Map<string, { street: 0 | 1 | 2 | 3; isButton: boolean; prior: number; bet: number; oppBet: number }>()
  interface Node {
    street: 0 | 1 | 2 | 3
    /** Seat order is relative to position: index 0 is the button. */
    bet: [number, number]
    total: [number, number]
    acted: [boolean, boolean]
    actor: 0 | 1
    minRaise: number
    canRaise: [boolean, boolean]
  }
  const visit = (n: Node): void => {
    const me = n.actor
    const opp = (1 - me) as 0 | 1
    const prior = n.total[me] - n.bet[me]
    const key = n.street + ':' + me + ':' + prior + ':' + n.bet[me] + ':' + n.bet[opp]
    if (seen.has(key)) return
    seen.set(key, { street: n.street, isButton: me === 0, prior, bet: n.bet[me], oppBet: n.bet[opp] })
    const current = Math.max(n.bet[0], n.bet[1])
    const maxTo = n.bet[me] + (STACK - n.total[me])
    const canRaise = n.canRaise[me] && n.total[opp] < STACK && maxTo > current
    const minTo = canRaise ? Math.min(current + n.minRaise, maxTo) : 1
    const spot: BetSpot = {
      bet: n.bet[me],
      oppBet: n.bet[opp],
      total: n.total[me],
      oppTotal: n.total[opp],
      minTo,
      maxTo: canRaise ? maxTo : 0,
    }
    for (const a of abstractActions(spot)) {
      if (a.id === FOLD) continue
      const bet: [number, number] = [n.bet[0], n.bet[1]]
      const total: [number, number] = [n.total[0], n.total[1]]
      const acted: [boolean, boolean] = [n.acted[0], n.acted[1]]
      const cr: [boolean, boolean] = [n.canRaise[0], n.canRaise[1]]
      let minRaise = n.minRaise
      if (a.id === CALL) {
        const pay = Math.min(current - bet[me], STACK - total[me])
        bet[me] += pay
        total[me] += pay
      } else {
        const size = a.to - current
        total[me] += a.to - bet[me]
        bet[me] = a.to
        if (size >= minRaise) {
          minRaise = size
          cr[opp] = true
        } else if (acted[opp]) cr[opp] = false
      }
      acted[me] = true
      if (bet[0] === bet[1] && acted[0] && acted[1]) {
        if (total[0] >= STACK || total[1] >= STACK || n.street === 3) continue
        visit({ street: (n.street + 1) as 1 | 2 | 3, bet: [0, 0], total, acted: [false, false], actor: 1, minRaise: BIG_BLIND, canRaise: [true, true] })
      } else {
        visit({ street: n.street, bet, total, acted, actor: opp, minRaise, canRaise: cr })
      }
    }
  }
  // Index 0 is the button: it posts the small blind and acts first preflop, last after the flop.
  visit({ street: 0, bet: [1, 2], total: [1, 2], acted: [false, false], actor: 0, minRaise: BIG_BLIND, canRaise: [true, true] })
  return Array.from(seen.values())
}

/** Infoset counts per street for a configuration (betting states times bucket count). */
export function tableSizeEstimate(config: AbstractionConfig): { states: number[]; infosets: number[]; total: number; bytes: number } {
  const states = [0, 0, 0, 0]
  for (const s of enumerateBettingStates()) states[s.street]!++
  const infosets = states.map((n, street) => n * (street === 0 ? PREFLOP_CLASSES : config.buckets[street - 1]!))
  const total = infosets.reduce((a, b) => a + b, 0)
  return { states, infosets, total, bytes: total * 16 }
}
