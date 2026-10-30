import type { Seat } from '../../types'
import { makeRng } from '../../rng'
import { shuffled } from './cards'
import { rank7 } from './evaluator'
import { BIG_BLIND } from './match'
import { applyAction, initMatch, type HoldemAction, type HoldemState } from './match'
import { spotOf } from './holdem-game'
import { CALL, FOLD, abstractActions, infoKey, preflopClass, streetEquity, type Abstraction, type AbstractAction } from './abstraction'

// Exact-style best response inside the abstraction, on a chance model estimated from sampled deals.
//
// The abstract game is the one the strategy was trained on: bucketed hands, fold / call / half pot / pot /
// all in. Its chance structure (how a hand's bucket moves from street to street, and who wins at showdown)
// is not enumerable, so it is estimated from sampled deals: each deal records both players' bucket on every
// street and the showdown result. The best responder sees its own bucket on the current street and the full
// betting history (the strategy under test sees only its bucket and the chips in the pot).
//
// Fitting a best response to a finite sample and scoring it on the same sample overstates it. So the best
// response is fitted on one set of deals and scored on a second set it has never seen; the held-out value
// is the reported number, the fitted-set value is kept to show the gap. Both are labelled "in abstraction,
// estimated from sampled deals": they say nothing about hands the abstraction cannot tell apart.

/** What the strategy under test does at an information set key: the action mask and a probability per action id, or null when the key is unknown. */
export type StrategyLookup = (key: string) => { mask: number; probs: ArrayLike<number> } | null

/** Equities and showdown results of sampled deals; buckets are cut from them per abstraction. */
export interface DealSample {
  n: number
  /** Per deal and seat: preflop class, then flop, turn and river equity. 8 numbers per deal: seat * 4 + street (street 0 holds the class). */
  value: Float32Array
  /** +1 when seat 0 wins at showdown, -1 when seat 1 does, 0 on a tie. */
  showdown: Int8Array
}

export function sampleDeals(n: number, seed: number): DealSample {
  const rng = makeRng(seed)
  const value = new Float32Array(n * 8)
  const showdown = new Int8Array(n)
  for (let i = 0; i < n; i++) {
    const d = shuffled(rng)
    const holes = [
      [d[0]!, d[1]!],
      [d[2]!, d[3]!],
    ]
    const board = d.slice(4, 9)
    for (let seat = 0; seat < 2; seat++) {
      const h = holes[seat]!
      value[i * 8 + seat * 4] = preflopClass(h[0]!, h[1]!)
      value[i * 8 + seat * 4 + 1] = streetEquity(1, h, board.slice(0, 3))
      value[i * 8 + seat * 4 + 2] = streetEquity(2, h, board.slice(0, 4))
      value[i * 8 + seat * 4 + 3] = streetEquity(3, h, board)
    }
    const a = rank7([...holes[0]!, ...board])
    const b = rank7([...holes[1]!, ...board])
    showdown[i] = a > b ? 1 : b > a ? -1 : 0
  }
  return { n, value, showdown }
}

/** Buckets of a deal sample under one abstraction. */
export interface BucketedDeals {
  n: number
  /** 8 per deal: seat * 4 + street. */
  bucket: Int16Array
  showdown: Int8Array
}

export function bucketDeals(sample: DealSample, abs: Abstraction): BucketedDeals {
  const bucket = new Int16Array(sample.n * 8)
  for (let i = 0; i < sample.n; i++) {
    for (let seat = 0; seat < 2; seat++) {
      bucket[i * 8 + seat * 4] = sample.value[i * 8 + seat * 4]!
      for (let street = 1; street <= 3; street++) {
        bucket[i * 8 + seat * 4 + street] = abs.bucketOfEquity(street as 1 | 2 | 3, sample.value[i * 8 + seat * 4 + street]!)
      }
    }
  }
  return { n: sample.n, bucket, showdown: sample.showdown }
}

function toReal(a: AbstractAction): HoldemAction {
  if (a.id === FOLD) return { type: 'fold' }
  if (a.id === CALL) return { type: 'call' }
  return { type: 'raise', to: a.to }
}

const toMbb = (chips: number): number => (chips / BIG_BLIND) * 1000

/** Scenarios whose weight falls below this fraction of their starting weight are dropped (the mass lost is below a millionth). */
const PRUNE = 1e-6

interface Walk {
  deals: BucketedDeals
  lookup: StrategyLookup
  brSeat: Seat
  /** The best response's choice (an action id) by "history|bucket"; filled when fitting, read when scoring. */
  policy: Map<string, number>
  fit: boolean
  /** Probability mass of the strategy's decisions, and the part of it at keys the strategy does not know (played uniformly). */
  decisionMass: number
  unknownMass: number
  floor: number
}

function utilities(w: Walk, s: HoldemState, idx: Int32Array, wt: Float64Array): Float64Array {
  const out = new Float64Array(idx.length)
  const last = s.last!
  if (!last.showdown) {
    const u = w.brSeat === 0 ? last.delta : -last.delta
    for (let k = 0; k < idx.length; k++) out[k] = wt[k]! * u
    return out
  }
  const half = last.pot / 2
  const sign = w.brSeat === 0 ? 1 : -1
  for (let k = 0; k < idx.length; k++) out[k] = wt[k]! * sign * w.deals.showdown[idx[k]!]! * half
  return out
}

function groupBy(w: Walk, idx: Int32Array, street: number, seat: Seat): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (let k = 0; k < idx.length; k++) {
    const b = w.deals.bucket[idx[k]! * 8 + seat * 4 + street]!
    const g = groups.get(b)
    if (g) g.push(k)
    else groups.set(b, [k])
  }
  return groups
}

function walk(w: Walk, s: HoldemState, idx: Int32Array, wt: Float64Array, hist: string): Float64Array {
  const actor = s.actor
  const opts = abstractActions(spotOf(s, actor))
  const result = new Float64Array(idx.length)
  const groups = groupBy(w, idx, s.street, actor)
  const children = (a: AbstractAction) => applyAction(s, actor, toReal(a))

  if (actor === w.brSeat) {
    if (w.fit) {
      const values: Float64Array[] = opts.map((a) => {
        const c = children(a)
        return c.hand > 0 || c.over ? utilities(w, c, idx, wt) : walk(w, c, idx, wt, hist + a.id + '.')
      })
      for (const [bucket, ks] of groups) {
        let best = 0
        let bestSum = -Infinity
        for (let j = 0; j < opts.length; j++) {
          let sum = 0
          for (const k of ks) sum += values[j]![k]!
          if (sum > bestSum + 1e-15) {
            bestSum = sum
            best = j
          }
        }
        w.policy.set(hist + '|' + bucket, opts[best]!.id)
        for (const k of ks) result[k] = values[best]![k]!
      }
      return result
    }
    // Scoring: follow the fitted choice; a group the fit never saw calls.
    const chosen = new Array<number[]>(opts.length)
    for (let j = 0; j < opts.length; j++) chosen[j] = []
    for (const [bucket, ks] of groups) {
      const id = w.policy.get(hist + '|' + bucket) ?? CALL
      let j = opts.findIndex((o) => o.id === id)
      if (j < 0) j = opts.findIndex((o) => o.id === CALL)
      for (const k of ks) chosen[j]!.push(k)
    }
    for (let j = 0; j < opts.length; j++) {
      const ks = chosen[j]!
      if (ks.length === 0) continue
      const sub = subset(idx, wt, ks)
      const c = children(opts[j]!)
      const vals = c.hand > 0 || c.over ? utilities(w, c, sub.idx, sub.wt) : walk(w, c, sub.idx, sub.wt, hist + opts[j]!.id + '.')
      for (let m = 0; m < ks.length; m++) result[ks[m]!] = vals[m]!
    }
    return result
  }

  // The strategy under test acts: split every scenario by the probability it gives each option.
  const probByBucket = new Map<number, number[]>()
  for (const bucket of groups.keys()) {
    const key = infoKey({ street: s.street, bucket, isButton: s.button === actor, prior: s.total[actor] - s.bet[actor], bet: s.bet[actor], oppBet: s.bet[(1 - actor) as Seat] })
    const row = w.lookup(key)
    let p = opts.map(() => 0)
    let sum = 0
    if (row) {
      p = opts.map((o) => ((row.mask >> o.id) & 1 ? row.probs[o.id]! : 0))
      sum = p.reduce((a, b) => a + b, 0)
    }
    for (const k of groups.get(bucket)!) w.decisionMass += wt[k]!
    if (!(sum > 0)) {
      for (const k of groups.get(bucket)!) w.unknownMass += wt[k]!
      p = opts.map(() => 1 / opts.length)
    } else p = p.map((x) => x / sum)
    probByBucket.set(bucket, p)
  }
  for (let j = 0; j < opts.length; j++) {
    const ks: number[] = []
    const cw: number[] = []
    for (const [bucket, members] of groups) {
      const pj = probByBucket.get(bucket)![j]!
      if (pj <= 0) continue
      for (const k of members) {
        const x = wt[k]! * pj
        if (x >= w.floor) {
          ks.push(k)
          cw.push(x)
        }
      }
    }
    if (ks.length === 0) continue
    const subIdx = Int32Array.from(ks, (k) => idx[k]!)
    const subWt = Float64Array.from(cw)
    const c = children(opts[j]!)
    const vals = c.hand > 0 || c.over ? utilities(w, c, subIdx, subWt) : walk(w, c, subIdx, subWt, hist + opts[j]!.id + '.')
    for (let m = 0; m < ks.length; m++) result[ks[m]!] += vals[m]!
  }
  return result
}

function subset(idx: Int32Array, wt: Float64Array, ks: number[]): { idx: Int32Array; wt: Float64Array } {
  return { idx: Int32Array.from(ks, (k) => idx[k]!), wt: Float64Array.from(ks, (k) => wt[k]!) }
}

function run(deals: BucketedDeals, lookup: StrategyLookup, brSeat: Seat, policy: Map<string, number>, fit: boolean): { perDeal: Float64Array; unknownMass: number; decisionMass: number } {
  const n = deals.n
  const w: Walk = { deals, lookup, brSeat, policy, fit, decisionMass: 0, unknownMass: 0, floor: PRUNE / n }
  const idx = Int32Array.from({ length: n }, (_, i) => i)
  const wt = new Float64Array(n).fill(1 / n)
  const root = initMatch(0, { deck: shuffled(makeRng(1)) })
  const vals = walk(w, root, idx, wt, '')
  // Each deal's expected chips for the best responder: undo the 1/n weight.
  const perDeal = new Float64Array(n)
  for (let i = 0; i < n; i++) perDeal[i] = vals[i]! * n
  return { perDeal, unknownMass: w.unknownMass, decisionMass: w.decisionMass }
}

/**
 * The value, in milli big blinds per hand, of a fixed best-response policy for `brSeat` (action id by "history|bucket", calling where
 * the policy has no entry) against `lookup` on `deals`. History is the action ids so far, each followed by a dot.
 */
export function evaluateStrategy(deals: BucketedDeals, lookup: StrategyLookup, brSeat: Seat, policy: Map<string, number>): number {
  const { perDeal } = run(deals, lookup, brSeat, policy, false)
  let sum = 0
  for (let i = 0; i < deals.n; i++) sum += perDeal[i]!
  return toMbb(sum / deals.n)
}

export interface AbstractBrResult {
  /** Milli big blinds per hand the best response wins on deals it was not fitted on (the reported exploitability, in abstraction). */
  heldOutMbb: number
  heldOutCi95: [number, number]
  /** The same best response scored on the deals it was fitted on (overstated by fitting). */
  fittedMbb: number
  /** The button's and the big blind's best-response values on the held-out deals, in milli big blinds. */
  seatMbb: [number, number]
  fitDeals: number
  scoreDeals: number
  /** Share of the strategy's decisions (by probability mass) at keys its table does not hold, played uniformly. */
  unknownShare: number
}

/**
 * Exploitability of `lookup` inside the abstraction: the mean of the two seats' best-response values
 * (seat 0 is the button), fitted on `fit` and scored on `score`.
 */
export function abstractBestResponse(lookup: StrategyLookup, fit: BucketedDeals, score: BucketedDeals): AbstractBrResult {
  const held: Float64Array[] = []
  let fitted = 0
  let unknown = 0
  let decisions = 0
  for (const seat of [0, 1] as const) {
    const policy = new Map<string, number>()
    const f = run(fit, lookup, seat, policy, true)
    let sum = 0
    for (let i = 0; i < fit.n; i++) sum += f.perDeal[i]!
    fitted += sum / fit.n / 2
    const s = run(score, lookup, seat, policy, false)
    held.push(s.perDeal)
    unknown += s.unknownMass
    decisions += s.decisionMass
  }
  const n = score.n
  const both = new Float64Array(n)
  for (let i = 0; i < n; i++) both[i] = (held[0]![i]! + held[1]![i]!) / 2
  let mean = 0
  for (let i = 0; i < n; i++) mean += both[i]!
  mean /= n
  let ss = 0
  for (let i = 0; i < n; i++) ss += (both[i]! - mean) ** 2
  const se = Math.sqrt(ss / (n - 1) / n)
  const seat = (arr: Float64Array): number => {
    let t = 0
    for (let i = 0; i < n; i++) t += arr[i]!
    return toMbb(t / n)
  }
  return {
    heldOutMbb: toMbb(mean),
    heldOutCi95: [toMbb(mean - 1.959964 * se), toMbb(mean + 1.959964 * se)],
    fittedMbb: toMbb(fitted),
    seatMbb: [seat(held[0]!), seat(held[1]!)],
    fitDeals: fit.n,
    scoreDeals: n,
    unknownShare: decisions > 0 ? unknown / decisions : 0,
  }
}
