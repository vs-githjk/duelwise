import { BIG_BLIND, STACK } from '@duelwise/core/src/games/holdem/match'
import type { HoldemObservation } from '@duelwise/core/src/games/holdem/core'
import { holdemCore } from '@duelwise/core/src/games/holdem/core'
import {
  ALLIN,
  CALL,
  FOLD,
  PREFLOP_CLASSES,
  preflopClass,
  abstractActions,
  infoKey,
  type Abstraction,
  type AbstractAction,
  type BetSpot,
} from '@duelwise/core/src/games/holdem/abstraction'
import { translationOutcomes } from '@duelwise/core/src/games/holdem/translate'
import { cardRank, cardSuit } from '@duelwise/core/src/games/holdem/cards'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createStubAgent } from '../stub-agent'
import { fetchTable, loadTable, type HoldemTable } from './table'

export interface HoldemAgentOpts extends AgentOpts {
  /** A parsed table, or raw/gzip table bytes. When absent the agent fetches `${tableBase}/${level}.bin.gz`. */
  table?: HoldemTable | Uint8Array
  tableBase?: string
  /** Play the most likely action instead of sampling (overrides the level's setting). */
  purify?: boolean
  /** Share of decisions played as a random legal option (overrides the level's setting). */
  explore?: number
  /** Play the loose-passive beginner mix over the table (overrides the level's setting). */
  beginner?: boolean
  /** Share of the weakest starting hands that are never shoved before the flop (overrides the level's setting). */
  shoveFloor?: number
  /** Share of every fold and raise played as a call instead (overrides the level's setting). */
  callBias?: number
  seed?: number
}

export const DEFAULT_TABLE_BASE = '/agents/holdem/v1'

/** What the policy remembers of its last action this street: the opponent's street bet when it acted and its own bet after acting. */
export interface PolicyMemory {
  hand: number
  street: number
  oppBet: number
  myBet: number
}
type Memory = PolicyMemory

/** One way the policy can read the opponent's last raise (a mixture over table sizes) and what it would then do at each of its options. */
export interface PolicyBranch {
  weight: number
  options: AbstractAction[]
  /** Probability of each option, parallel to `options`. */
  probs: number[]
}

/** A rough 0..1 strength for the rare spot a table does not cover. */
function preflopStrength(c1: number, c2: number): number {
  const hi = Math.max(cardRank(c1), cardRank(c2))
  const lo = Math.min(cardRank(c1), cardRank(c2))
  let s = hi / 12 * 0.6 + lo / 12 * 0.2
  if (hi === lo) s += 0.35
  if (cardSuit(c1) === cardSuit(c2)) s += 0.05
  if (hi - lo <= 2) s += 0.05
  return Math.min(1, s)
}

/** The distribution that puts everything on the first largest entry: what a purified policy plays. */
function oneHotAtMax(probs: number[]): number[] {
  let best = 0
  for (let i = 1; i < probs.length; i++) if (probs[i]! > probs[best]!) best = i
  return probs.map((_, i) => (i === best ? 1 : 0))
}

/** Remove low-probability actions after all policy adjustments, retaining the largest if all are below the floor. */
export const PROBABILITY_FLOOR = 0.05
export function pruneProbs(probs: number[], floor = PROBABILITY_FLOOR): number[] {
  const total = probs.reduce((a, b) => a + b, 0)
  if (total <= 0) return probs.map((_, i) => i === 0 ? 1 : 0)
  const kept = probs.map((p) => p / total < floor ? 0 : p / total)
  const sum = kept.reduce((a, b) => a + b, 0)
  if (sum <= 0) return oneHotAtMax(probs)
  return kept.map((p) => p / sum)
}

/** Where each preflop class sits in the ranking of all 1326 starting hands (0 weakest, 1 strongest), by the rough strength rule above. */
const PREFLOP_PERCENTILE: number[] = (() => {
  const score = new Array<number>(PREFLOP_CLASSES).fill(0)
  const weight = new Array<number>(PREFLOP_CLASSES).fill(0)
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const k = preflopClass(a, b)
      score[k] = preflopStrength(a, b)
      weight[k]!++
    }
  }
  return score.map((x, k) => {
    let below = 0
    for (let j = 0; j < PREFLOP_CLASSES; j++) if (score[j]! < x) below += weight[j]!
    return (below + weight[k]! / 2) / 1326
  })
})()

/** How strong a hand is among hands on its street, 0 to 1: the preflop ranking, or the equity bucket's place among the buckets. */
export function handPercentile(street: number, bucket: number, buckets: number): number {
  return street === 0 ? PREFLOP_PERCENTILE[bucket]! : bucket / Math.max(1, buckets - 1)
}

/** The weakest share of hands a beginner never shoves with, and the strongest share (the top 12 percent, a margin over the top 5 percent a player calls premium) that never folds preflop. */
const BEGINNER_WEAK = 0.3
const BEGINNER_PREMIUM = 0.88
/** Share of the table's folds a beginner calls instead, and share of its raises it keeps. */
const BEGINNER_CALLS_INSTEAD = 0.6
const BEGINNER_KEEPS_RAISE = 0.6
const BEGINNER_KEEPS_WEAK_RAISE = 0.15
const BEGINNER_KEEPS_MID_ALLIN = 0.3

/**
 * The loose-passive beginner (Easy): the table's choice reshaped, never replaced by a random option.
 * It calls a lot (most folds become calls), raises less than the table, shoves only with a strong hand,
 * seldom raises with a weak one, and never folds a premium hand before the flop.
 * `probs` is parallel to `ids` (action ids); the result sums to the same total. Pure.
 */
export function beginnerProbs(probs: number[], ids: number[], street: number, bucket: number, buckets: number): number[] {
  const pct = handPercentile(street, bucket, buckets)
  const callAt = ids.indexOf(CALL)
  if (callAt < 0) return probs
  const out = probs.slice()
  const move = (i: number, keep: number): void => {
    const moved = out[i]! * (1 - keep)
    out[i] = out[i]! - moved
    out[callAt] = out[callAt]! + moved
  }
  ids.forEach((id, i) => {
    if (id === FOLD) move(i, street === 0 && pct >= BEGINNER_PREMIUM ? 0 : 1 - BEGINNER_CALLS_INSTEAD)
    else if (id === ALLIN) move(i, pct < BEGINNER_WEAK ? 0 : pct < 0.7 ? BEGINNER_KEEPS_MID_ALLIN : BEGINNER_KEEPS_RAISE)
    else if (id !== CALL) move(i, pct < BEGINNER_WEAK ? BEGINNER_KEEPS_WEAK_RAISE : BEGINNER_KEEPS_RAISE)
  })
  return out
}

/**
 * The weakest `floor` share of starting hands is never shoved before the flop: the table's shove with one of them
 * (a bluff the abstraction likes) goes onto fold, or onto call when folding is not an option. Later streets and
 * stronger hands are untouched. `probs` is parallel to `ids`; the total is kept. Pure.
 */
export function shoveFloorProbs(probs: number[], ids: number[], street: number, bucket: number, buckets: number, floor: number): number[] {
  if (street !== 0 || floor <= 0 || handPercentile(street, bucket, buckets) >= floor) return probs
  const shove = ids.indexOf(ALLIN)
  const to = ids.includes(FOLD) ? ids.indexOf(FOLD) : ids.indexOf(CALL)
  if (shove < 0 || to < 0) return probs
  const out = probs.slice()
  out[to] = out[to]! + out[shove]!
  out[shove] = 0
  return out
}

/**
 * The calling-station dial: `bias` is the share of every fold and raise (the shove included) that becomes a call.
 * 0 plays the table, 1 always calls. Used to cut a level below the table's own strength. `probs` is parallel to `ids`; the total is kept. Pure.
 */
export function callBiasProbs(probs: number[], ids: number[], bias: number): number[] {
  const callAt = ids.indexOf(CALL)
  if (bias <= 0 || callAt < 0) return probs
  const out = probs.slice()
  ids.forEach((id, i) => {
    if (id === CALL) return
    const moved = out[i]! * bias
    out[i] = out[i]! - moved
    out[callAt] = out[callAt]! + moved
  })
  return out
}

export class HoldemPolicy {
  private abs: Abstraction
  /** Spots the table did not cover and the heuristic answered. */
  misses = 0
  private memory: Memory | null = null
  private readonly bucketMemo: Map<number, number> | null
  /** Share of decisions where the policy plays a uniformly random legal option instead of its table (the Easy level). */
  private readonly explore: number
  /** Play the loose-passive beginner mix over the table (the Easy level). */
  private readonly beginner: boolean
  /** Share of the weakest starting hands never shoved before the flop (the Medium, Hard and Champion levels). */
  private readonly shoveFloor: number
  /** Share of every fold and raise played as a call (the Medium level). */
  private readonly callBias: number
  private readonly premiumProtection: boolean

  /** `memoBuckets` caches the (deterministic) bucket of every hand and board seen; the measurement tools ask for many hypothetical hands. */
  constructor(readonly table: HoldemTable, private readonly purify: boolean, opts: { memoBuckets?: boolean; explore?: number; beginner?: boolean; shoveFloor?: number; callBias?: number; premiumProtection?: boolean } = {}) {
    this.abs = table.abstraction()
    this.bucketMemo = opts.memoBuckets ? new Map() : null
    this.explore = opts.explore ?? 0
    this.beginner = opts.beginner ?? false
    this.shoveFloor = opts.shoveFloor ?? 0
    this.callBias = opts.callBias ?? 0
    this.premiumProtection = opts.premiumProtection ?? false
    if (!(this.callBias >= 0 && this.callBias <= 1)) throw new Error('holdem agent: callBias must be between 0 and 1')
    if (!(this.explore >= 0 && this.explore <= 1)) throw new Error('holdem agent: explore must be between 0 and 1')
  }

  reset(): void {
    this.memory = null
  }

  /** The opponent's spot before its last raise, when this decision answers one: the translation of that raise then applies. */
  private translationSpot(obs: HoldemObservation, mem: Memory | null): BetSpot | null {
    const prev = this.opponentSpot(obs, mem)
    return prev && obs.bet[(1 - obs.seat) as 0 | 1] > prev.oppBet ? prev : null
  }

  private spotFor(obs: HoldemObservation): BetSpot {
    const me = obs.seat
    const opp = (1 - me) as 0 | 1
    return {
      bet: obs.bet[me],
      oppBet: obs.bet[opp],
      total: obs.total[me],
      oppTotal: obs.total[opp],
      minTo: obs.minRaiseTo > 0 ? obs.minRaiseTo : 1,
      maxTo: obs.maxRaiseTo > 0 ? obs.maxRaiseTo : 0,
    }
  }

  private memoryFor(obs: HoldemObservation): Memory | null {
    return this.memory && this.memory.hand === obs.hand && this.memory.street === obs.street ? this.memory : null
  }

  private bucketOf(obs: HoldemObservation): number {
    if (!this.bucketMemo) return this.abs.bucket(obs.street, obs.hole, obs.board)
    let k = obs.street
    for (const c of obs.hole) k = k * 52 + c
    for (const c of obs.board) k = k * 52 + c
    let b = this.bucketMemo.get(k)
    if (b === undefined) {
      if (this.bucketMemo.size >= 400_000) this.bucketMemo.clear()
      b = this.abs.bucket(obs.street, obs.hole, obs.board)
      this.bucketMemo.set(k, b)
    }
    return b
  }

  /** The options and their probabilities when the table reads the opponent's bet as `keyOppBet`. */
  private strategyBranch(obs: HoldemObservation, keyOppBet: number, mine: AbstractAction[]): { options: AbstractAction[]; probs: number[] } {
    const me = obs.seat
    const bet = obs.bet[me]
    const holeBucket = this.bucketOf(obs)
    const prior = obs.total[me] - bet
    const build = (p: number): string =>
      infoKey({ street: obs.street, bucket: holeBucket, isButton: obs.isButton, prior: p, bet, oppBet: keyOppBet })
    let key = build(prior)
    let strat = this.table.strategyFor(key)
    if (strat.length === 0 && obs.street > 0) {
      const known = this.table.header.priors[obs.street] ?? []
      if (known.length > 0) {
        let best = known[0]!
        for (const k of known) if (Math.abs(Math.log((k + 1) / (prior + 1))) < Math.abs(Math.log((best + 1) / (prior + 1)))) best = k
        key = build(best)
        strat = this.table.strategyFor(key)
      }
    }
    let probs: number[]
    if (strat.length === 0) {
      this.misses++
      probs = this.fallback(obs, holeBucket, mine)
    } else {
      const mask = this.table.maskFor(key)
      probs = mine.map((a) => ((mask >> a.id) & 1 ? strat[a.id]! : 0))
      if (probs.reduce((s, x) => s + x, 0) <= 0) probs = mine.map(() => 1)
    }
    if (this.beginner) probs = beginnerProbs(probs, mine.map((a) => a.id), obs.street, holeBucket, this.abs.size(obs.street))
    if (this.callBias > 0) probs = callBiasProbs(probs, mine.map((a) => a.id), this.callBias)
    if (this.shoveFloor > 0) probs = shoveFloorProbs(probs, mine.map((a) => a.id), obs.street, holeBucket, this.abs.size(obs.street), this.shoveFloor)
    return { options: mine, probs }
  }

  /**
   * Everything the policy could do at `obs` (a purified policy puts all its weight on its one choice), as a mixture over how it reads the opponent's last raise.
   * Pure: nothing is sampled and no memory changes. `mem` is what the policy remembers of this street
   * (null when it has not acted on it).
   */
  branches(obs: HoldemObservation, mem: Memory | null): PolicyBranch[] {
    const mine = abstractActions(this.spotFor(obs))
    const prev = this.translationSpot(obs, mem)
    const reads = prev
      ? translationOutcomes(prev, obs.bet[(1 - obs.seat) as 0 | 1]).map((o) => ({ to: o.action.to, weight: o.p })).filter((o) => o.weight > 0)
      : [{ to: obs.bet[(1 - obs.seat) as 0 | 1], weight: 1 }]
    return reads.map((r) => {
      const b = this.strategyBranch(obs, r.to, mine)
      return { weight: r.weight, options: b.options, probs: this.finalProbs(obs, mem, b.options, b.probs) }
    })
  }

  /** The table's probabilities mixed with a uniform choice at the exploration rate. */
  private withExploration(probs: number[]): number[] {
    if (this.explore <= 0) return probs
    const total = probs.reduce((s, x) => s + x, 0)
    return probs.map((x) => (1 - this.explore) * (total > 0 ? x / total : 1 / probs.length) + this.explore / probs.length)
  }

  /** Apply protection and the probability floor to the same distribution used for display and sampling. */
  private finalProbs(obs: HoldemObservation, mem: Memory | null, options: AbstractAction[], probs: number[]): number[] {
    const out = this.withExploration(this.purify ? oneHotAtMax(probs) : probs).slice()
    const [a, b] = obs.hole
    if (this.premiumProtection && obs.street === 0 && a !== undefined && b !== undefined) {
      const hi = Math.max(cardRank(a), cardRank(b))
      const lo = Math.min(cardRank(a), cardRank(b))
      const pair = hi === lo
      const prev = this.translationSpot(obs, mem)
      const minRaise = prev !== null && obs.bet[1 - obs.seat] <= prev.minTo
      const protectedHand = (pair && hi >= 10) || (hi === 12 && lo === 11 && cardSuit(a) === cardSuit(b)) || (pair && hi >= 8 && minRaise)
      const fold = options.findIndex((o) => o.id === FOLD)
      const call = options.findIndex((o) => o.id === CALL)
      if (protectedHand && fold >= 0 && call >= 0) { out[call] = out[call]! + out[fold]!; out[fold] = 0 }
    }
    return pruneProbs(out)
  }

  /** The action code the core understands. */
  decide(obs: HoldemObservation, rng: Rng): number {
    const me = obs.seat
    if (!obs.toMove) return holdemCore.encodeAction({ type: 'call' })
    const spot = this.spotFor(obs)
    const mine = abstractActions(spot)
    // Opponent bet as the table knows it: an off-tree raise is translated to an abstract size.
    const mem = this.memoryFor(obs)
    const prev = this.translationSpot(obs, mem)
    let keyOppBet = obs.bet[(1 - me) as 0 | 1]
    if (prev) {
      const outcomes = translationOutcomes(prev, keyOppBet)
      const u = rng.float()
      keyOppBet = (outcomes.length === 1 || u < outcomes[0]!.p ? outcomes[0]! : outcomes[1]!).action.to
    }
    const raw = this.strategyBranch(obs, keyOppBet, mine).probs
    const chosen = this.pick(mine, this.finalProbs(obs, mem, mine, raw), rng)
    this.remember(obs, chosen)
    return this.toCode(chosen, spot)
  }

  private opponentSpot(obs: HoldemObservation, mem: Memory | null): BetSpot | null {
    const me = obs.seat
    const opp = (1 - me) as 0 | 1
    let y: number
    let m: number
    if (mem) {
      y = mem.oppBet
      m = mem.myBet
    } else if (obs.street === 0) {
      if (obs.isButton) return null // I act first preflop, the opponent has not acted
      y = BIG_BLIND / 2
      m = BIG_BLIND
    } else {
      if (!obs.isButton) return null // the opponent acts after me
      y = 0
      m = 0
    }
    const oppTotalBefore = obs.total[opp] - (obs.bet[opp] - y)
    const minTo = m + Math.max(BIG_BLIND, m - y)
    const maxTo = y + (STACK - oppTotalBefore)
    return { bet: y, oppBet: m, total: oppTotalBefore, oppTotal: obs.total[me], minTo, maxTo }
  }

  private fallback(obs: HoldemObservation, bucket: number, mine: AbstractAction[]): number[] {
    const strength = obs.street === 0 ? preflopStrength(obs.hole[0]!, obs.hole[1]!) : bucket / Math.max(1, this.abs.size(obs.street) - 1)
    const facing = obs.bet[(1 - obs.seat) as 0 | 1] > obs.bet[obs.seat]
    const want = (ids: number[]): number[] => {
      for (const id of ids) {
        const i = mine.findIndex((a) => a.id === id)
        if (i >= 0) return mine.map((_, k) => (k === i ? 1 : 0))
      }
      return mine.map((a) => (a.id === CALL ? 1 : 0))
    }
    if (facing) return strength < 0.35 ? want([FOLD]) : strength < 0.75 ? want([CALL]) : want([3, 2, CALL])
    return strength < 0.4 ? want([CALL]) : strength < 0.8 ? want([2, CALL]) : want([3, 2, CALL])
  }

  private pick(mine: AbstractAction[], probs: number[], rng: Rng): AbstractAction {
    const total = probs.reduce((s, x) => s + x, 0)
    let x = rng.float() * total
    for (let i = 0; i < mine.length; i++) {
      x -= probs[i]!
      if (x < 0) return mine[i]!
    }
    return mine[mine.length - 1]!
  }

  private remember(obs: HoldemObservation, a: AbstractAction): void {
    const me = obs.seat
    const opp = (1 - me) as 0 | 1
    const myBet = a.id === FOLD ? obs.bet[me] : a.to
    this.memory = { hand: obs.hand, street: obs.street, oppBet: obs.bet[opp], myBet }
  }

  private toCode(a: AbstractAction, spot: BetSpot): number {
    if (a.id === FOLD) return holdemCore.encodeAction({ type: 'fold' })
    if (a.id === CALL) return holdemCore.encodeAction({ type: 'call' })
    const to = Math.min(Math.max(a.to, spot.minTo), spot.maxTo)
    return holdemCore.encodeAction({ type: 'raise', to })
  }
}

/** An agent over a loaded table. */
export function createHoldemAgent(table: HoldemTable, opts: { purify?: boolean; explore?: number; beginner?: boolean; shoveFloor?: number; callBias?: number; premiumProtection?: boolean; seed?: number; memoBuckets?: boolean } = {}): PreviewAgent & { policy: HoldemPolicy } {
  const policy = new HoldemPolicy(table, opts.purify ?? false, { memoBuckets: opts.memoBuckets, explore: opts.explore, beginner: opts.beginner, shoveFloor: opts.shoveFloor, callBias: opts.callBias, premiumProtection: opts.premiumProtection })
  let rng = makeRng(opts.seed ?? 0)
  return {
    preview: false,
    policy,
    reset(seed) {
      rng = makeRng(seed)
      policy.reset()
    },
    async act(obs) {
      return [policy.decide(obs as HoldemObservation, rng)]
    },
    dispose() {},
  }
}

/**
 * How each level plays its table (the table itself is `${level}.bin.gz`; the registry records which snapshot it is).
 * `purify` plays the most likely action instead of sampling; `explore` is the share of decisions played as a uniformly random legal option;
 * `beginner` reshapes the table's choice into a loose-passive beginner (see beginnerProbs);
 * `shoveFloor` is the share of the weakest starting hands that are never shoved before the flop (see shoveFloorProbs);
 * `callBias` is the share of every fold and raise played as a call instead (see callBiasProbs).
 */
export interface HoldemLevelSettings {
  purify: boolean
  explore: number
  beginner: boolean
  shoveFloor: number
  callBias: number
  premiumProtection: boolean
  probabilityFloor: number
}

export const HOLDEM_LEVELS: Record<Level, HoldemLevelSettings> = {
  easy: { purify: false, explore: 0, beginner: true, shoveFloor: 0, callBias: 0.5, premiumProtection: false, probabilityFloor: PROBABILITY_FLOOR },
  medium: { purify: false, explore: 0, beginner: false, shoveFloor: 0.25, callBias: 0.5, premiumProtection: false, probabilityFloor: PROBABILITY_FLOOR },
  hard: { purify: false, explore: 0, beginner: false, shoveFloor: 0.25, callBias: 0, premiumProtection: true, probabilityFloor: PROBABILITY_FLOOR },
  champion: { purify: false, explore: 0, beginner: false, shoveFloor: 0, callBias: 0, premiumProtection: true, probabilityFloor: PROBABILITY_FLOOR },
}

/** Levels and tables: each level loads its own snapshot and plays it with the settings above. */
export async function createGameAgent(level: Level, opts: HoldemAgentOpts = {}): Promise<PreviewAgent> {
  let table: HoldemTable | null = null
  try {
    if (opts.table instanceof Uint8Array) table = loadTable(opts.table)
    else if (opts.table) table = opts.table
    else table = await fetchTable(`${opts.tableBase ?? DEFAULT_TABLE_BASE}/${level}.bin.gz`)
  } catch {
    table = null
  }
  if (!table) return createStubAgent('holdem', level, opts) // table not published yet: preview
  const settings = HOLDEM_LEVELS[level]
  return createHoldemAgent(table, { purify: opts.purify ?? settings.purify, explore: opts.explore ?? settings.explore, beginner: opts.beginner ?? settings.beginner, shoveFloor: opts.shoveFloor ?? settings.shoveFloor, callBias: opts.callBias ?? settings.callBias, premiumProtection: settings.premiumProtection, seed: opts.seed })
}
