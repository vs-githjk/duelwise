import type { Rng, Seat } from '../../types'
import { makeRng } from '../../rng'
import { holdemCore, type HoldemObservation } from './core'
import { CALL, FOLD, type AbstractAction } from './abstraction'
import { rank7 } from './evaluator'
import { BIG_BLIND, MATCH_HANDS, STACK, applyAction, initMatch, raiseRange, type HoldemAction, type HoldemState } from './match'

// Local best response (Lisy and Bowling 2016) against a fixed hold'em strategy on the real game.
//
// The best responder knows the victim's strategy, never its cards. It keeps a belief over the victim's
// hands, updates it from every action the victim takes (Bayes over the victim's own action
// probabilities), and at each turn picks the action with the best expected result when
//   - folding costs what it has put in,
//   - calling means the hand is checked down to showdown,
//   - raising to r means the victim folds with the probability its strategy gives, and otherwise the
//     hand is checked down at the raised pot.
// Whatever the belief gets wrong only makes this a weaker player: the chips it actually wins against the
// victim over many hands are a lower bound on how exploitable the victim is. That realised win rate,
// with a confidence interval, is what is reported.

/** What the victim remembers of its last action on the current street (public once it has acted). */
export interface StreetMemory {
  hand: number
  street: number
  oppBet: number
  myBet: number
}

/** One way the victim can read our last raise, and what it would do at each of its options. */
export interface VictimBranch {
  weight: number
  options: AbstractAction[]
  /** Parallel to `options`; need not sum to one. */
  probs: ArrayLike<number>
}

export interface LbrVictim {
  /** The victim's decision at `obs` (its own observation, with any hole cards we want to ask about). */
  branches(obs: HoldemObservation, mem: StreetMemory | null): VictimBranch[]
}

export interface LbrOptions {
  /** Opponent hands kept in the belief on each street (a weighted resample when more are possible). */
  particles?: number
  /** Raise sizes tried, as fractions of the pot after calling; all in is always tried. */
  raiseFractions?: number[]
  /** Board runouts sampled to estimate equity when more than one card is to come (one card to come is exact). */
  runouts?: { preflop: number; flop: number }
  seed?: number
}

const DEFAULT_FRACTIONS = [0.33, 0.5, 0.75, 1, 1.5, 2]

const COMBOS: Array<[number, number]> = []
for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) COMBOS.push([a, b])
const N_COMBOS = COMBOS.length

function comboHas(c: number, cards: ReadonlySet<number>): boolean {
  const [a, b] = COMBOS[c]!
  return cards.has(a) || cards.has(b)
}

/** The probability the branch gives the real action that was taken. */
function actionProbability(branch: VictimBranch, action: HoldemAction): number {
  let total = 0
  for (let i = 0; i < branch.options.length; i++) total += branch.probs[i]!
  if (total <= 0) return 0
  for (let i = 0; i < branch.options.length; i++) {
    const o = branch.options[i]!
    const hit =
      action.type === 'fold' ? o.id === FOLD : action.type === 'call' ? o.id === CALL : action.type === 'raise' && o.id > CALL && o.to === action.to
    if (hit) return branch.probs[i]! / total
  }
  return 0
}

/** The mixture's probability that the victim folds. */
function foldProbability(branches: VictimBranch[]): number {
  let p = 0
  for (const b of branches) {
    let total = 0
    let fold = 0
    for (let i = 0; i < b.options.length; i++) {
      total += b.probs[i]!
      if (b.options[i]!.id === FOLD) fold += b.probs[i]!
    }
    if (total > 0) p += b.weight * (fold / total)
  }
  return p
}

export class LbrAgent {
  private readonly particles: number
  private readonly fractions: number[]
  private readonly runouts: { preflop: number; flop: number }
  private rng: Rng
  /** The public betting only: dummy cards, never the real deal. */
  private mirror: HoldemState
  private handNo = -1
  private weights = new Float64Array(N_COMBOS)
  private particleStreet = -1
  private mem: StreetMemory | null = null
  /** Times the belief collapsed (no hand explained the victim's action) and was reset to uniform. */
  resets = 0
  /** Victim actions the belief was updated on. */
  updates = 0

  constructor(private readonly victim: LbrVictim, readonly seat: Seat, opts: LbrOptions = {}) {
    this.particles = opts.particles ?? 250
    this.fractions = opts.raiseFractions ?? DEFAULT_FRACTIONS
    this.runouts = opts.runouts ?? { preflop: 48, flop: 32 }
    this.rng = makeRng(opts.seed ?? 1)
    this.mirror = initMatch(0)
  }

  /** Starts a new match; `seed` only seeds this agent's own sampling. */
  reset(seed: number): void {
    this.rng = makeRng(seed)
    this.mirror = initMatch(0)
    this.handNo = -1
    this.particleStreet = -1
    this.mem = null
  }

  /** The belief over the victim's hands, indexed by card pair (a < b), for diagnostics and tests. */
  belief(): Float64Array {
    return this.weights.slice()
  }

  static comboIndex(a: number, b: number): number {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    return lo * 51 - (lo * (lo - 1)) / 2 + (hi - lo - 1)
  }

  private dead(obs: HoldemObservation): Set<number> {
    return new Set([...obs.hole, ...obs.board])
  }

  private sync(obs: HoldemObservation): void {
    if (this.mirror.hand !== obs.hand) throw new Error(`lbr: public state is at hand ${this.mirror.hand}, the game is at ${obs.hand}`)
    if (obs.hand !== this.handNo) {
      this.handNo = obs.hand
      this.weights.fill(1)
      this.particleStreet = -1
      this.mem = null
    }
    const dead = this.dead(obs)
    for (let c = 0; c < N_COMBOS; c++) if (this.weights[c]! > 0 && comboHas(c, dead)) this.weights[c] = 0
    if (obs.street !== this.particleStreet) {
      this.particleStreet = obs.street
      this.resample()
    }
  }

  private liveCount(): number {
    let n = 0
    for (let c = 0; c < N_COMBOS; c++) if (this.weights[c]! > 0) n++
    return n
  }

  /** Keeps at most `particles` hands, drawn without replacement in proportion to their weight, each with weight one. */
  private resample(): void {
    if (this.liveCount() <= this.particles) return
    const keys: Array<[number, number]> = []
    for (let c = 0; c < N_COMBOS; c++) {
      const w = this.weights[c]!
      if (w > 0) keys.push([Math.log(Math.max(this.rng.float(), 1e-300)) / w, c])
    }
    keys.sort((p, q) => q[0] - p[0])
    this.weights.fill(0)
    for (let i = 0; i < this.particles; i++) this.weights[keys[i]![1]] = 1
  }

  private live(obs: HoldemObservation): number[] {
    const out: number[] = []
    const dead = this.dead(obs)
    for (let c = 0; c < N_COMBOS; c++) if (this.weights[c]! > 0 && !comboHas(c, dead)) out.push(c)
    return out
  }

  private memFor(obs: HoldemObservation): StreetMemory | null {
    return this.mem && this.mem.hand === obs.hand && this.mem.street === obs.street ? this.mem : null
  }

  /** The victim's observation after `state`, built from public information, for the hand `hole`. */
  private victimObs(state: HoldemState, board: number[], hole: number[]): HoldemObservation {
    const v = (1 - this.seat) as Seat
    const { minTo, maxTo } = raiseRange(state, v)
    const can = minTo <= maxTo
    return {
      seat: v,
      hand: state.hand,
      handsTotal: MATCH_HANDS,
      hole,
      board,
      street: state.street,
      bet: [state.bet[0], state.bet[1]],
      total: [state.total[0], state.total[1]],
      isButton: state.button === v,
      toMove: true,
      minRaiseTo: can ? minTo : 0,
      maxRaiseTo: can ? maxTo : 0,
      net: [state.net[0], state.net[1]],
      last: null,
    }
  }

  /** My equity (wins plus half ties) against each hand in `combos`, with the rest of the board dealt at random. */
  private equities(obs: HoldemObservation, combos: number[]): Float64Array {
    const known = this.dead(obs)
    const rest: number[] = []
    for (let c = 0; c < 52; c++) if (!known.has(c)) rest.push(c)
    const need = 5 - obs.board.length
    const runs: number[][] = []
    if (need === 0) runs.push([])
    else if (need === 1) for (const c of rest) runs.push([c])
    else {
      const count = need === 2 ? this.runouts.flop : this.runouts.preflop
      for (let r = 0; r < count; r++) {
        const pool = rest.slice()
        const run: number[] = []
        for (let i = 0; i < need; i++) {
          const j = i + this.rng.int(pool.length - i)
          ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
          run.push(pool[i]!)
        }
        runs.push(run)
      }
    }
    const buf = new Array<number>(7)
    const mine: number[] = runs.map((run) => {
      const cards = [...obs.hole, ...obs.board, ...run]
      return rank7(cards)
    })
    const out = new Float64Array(combos.length)
    const boardLen = obs.board.length
    for (let k = 0; k < combos.length; k++) {
      const [a, b] = COMBOS[combos[k]!]!
      let score = 0
      let n = 0
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r]!
        let clash = false
        for (let i = 0; i < run.length; i++) if (run[i] === a || run[i] === b) clash = true
        if (clash) continue
        buf[0] = a
        buf[1] = b
        for (let i = 0; i < boardLen; i++) buf[2 + i] = obs.board[i]!
        for (let i = 0; i < run.length; i++) buf[2 + boardLen + i] = run[i]!
        const theirs = rank7(buf)
        score += mine[r]! > theirs ? 1 : mine[r]! === theirs ? 0.5 : 0
        n++
      }
      out[k] = n > 0 ? score / n : 0.5
    }
    return out
  }

  /** Raise-to amounts worth trying at this spot. */
  private raiseTargets(obs: HoldemObservation): number[] {
    if (obs.maxRaiseTo <= 0) return []
    const opp = (1 - this.seat) as Seat
    const owed = Math.max(0, obs.bet[opp] - obs.bet[this.seat])
    const pot = obs.total[0] + obs.total[1]
    const set = new Set<number>()
    for (const f of this.fractions) {
      const want = obs.bet[opp] + Math.round(f * (pot + owed))
      set.add(Math.min(Math.max(want, obs.minRaiseTo), obs.maxRaiseTo))
    }
    set.add(obs.maxRaiseTo)
    return [...set].sort((a, b) => a - b)
  }

  /** The best action at my turn. Uses only my own observation and the public betting. */
  act(obs: HoldemObservation): HoldemAction {
    if (!obs.toMove) throw new Error('lbr: not my turn')
    this.sync(obs)
    if (this.mirror.actor !== this.seat) throw new Error('lbr: public state says it is not my turn')
    const me = this.seat
    const opp = (1 - me) as Seat
    const combos = this.live(obs)
    const eq = this.equities(obs, combos)
    let wsum = 0
    for (const c of combos) wsum += this.weights[c]!
    const owed = Math.max(0, obs.bet[opp] - obs.bet[me])
    const mem = this.memFor(obs)

    let best: HoldemAction = { type: 'call' }
    let bestEv = -Infinity
    const consider = (ev: number, a: HoldemAction) => {
      if (ev > bestEv + 1e-12) {
        bestEv = ev
        best = a
      }
    }
    // Calling: the hand is checked down.
    const callTotal = obs.total[me] + Math.min(owed, STACK - obs.total[me])
    {
      let ev = 0
      for (let k = 0; k < combos.length; k++) ev += this.weights[combos[k]!]! * (2 * eq[k]! - 1) * callTotal
      consider(ev / wsum, { type: 'call' })
    }
    if (owed > 0) consider(-obs.total[me], { type: 'fold' })
    for (const to of this.raiseTargets(obs)) {
      const after = applyAction(this.mirror, me, { type: 'raise', to })
      const base = this.victimObs(after, obs.board, [])
      const myTotal = after.total[me]
      const theirTotal = after.total[opp]
      let ev = 0
      for (let k = 0; k < combos.length; k++) {
        const [a, b] = COMBOS[combos[k]!]!
        const pf = foldProbability(this.victim.branches({ ...base, hole: [a, b] }, mem))
        ev += this.weights[combos[k]!]! * (pf * theirTotal + (1 - pf) * (2 * eq[k]! - 1) * myTotal)
      }
      consider(ev / wsum, { type: 'raise', to })
    }
    this.mirror = applyAction(this.mirror, me, best)
    return best
  }

  /**
   * The victim just took `action`. `obs` is my observation from just before it acted. Updates the belief with
   * how likely each possible victim hand was to take that action, then moves the public state on.
   */
  observeOpponent(obs: HoldemObservation, action: HoldemAction): void {
    this.sync(obs)
    const v = (1 - this.seat) as Seat
    if (this.mirror.actor !== v) throw new Error('lbr: public state says the victim is not to act')
    const combos = this.live(obs)
    const base = this.victimObs(this.mirror, obs.board, [])
    const mem = this.memFor(obs)
    let total = 0
    for (const c of combos) {
      const [a, b] = COMBOS[c]!
      let like = 0
      for (const br of this.victim.branches({ ...base, hole: [a, b] }, mem)) like += br.weight * actionProbability(br, action)
      this.weights[c] = this.weights[c]! * like
      total += this.weights[c]!
    }
    this.updates++
    if (!(total > 0)) {
      // No hand explains the action (a model gap): start again from every hand that is still possible.
      this.resets++
      for (const c of combos) this.weights[c] = 1
    }
    const before = this.mirror
    this.mirror = applyAction(this.mirror, v, action)
    this.mem =
      this.mirror.hand === before.hand && this.mirror.street === before.street && !this.mirror.over
        ? { hand: obs.hand, street: obs.street, oppBet: obs.bet[this.seat], myBet: this.mirror.bet[v] }
        : null
  }
}

// ---------- playing matches ----------

/** Plays one match of `MATCH_HANDS` hands; returns the chips the best responder won on each hand. */
export function playLbrMatch(opts: {
  seed: number
  lbr: LbrAgent
  /** The victim as it really plays: an action code from its own observation. */
  victim: (obs: HoldemObservation, rng: Rng) => number
  victimRng: Rng
}): number[] {
  const { lbr } = opts
  const me = lbr.seat
  lbr.reset(opts.seed ^ 0x1b5)
  let s = holdemCore.init(opts.seed)
  const deltas: number[] = []
  let hand = 0
  let net = 0
  while (!holdemCore.terminal(s)) {
    const actor = s.actor
    let next: HoldemState
    if (actor === me) {
      const action = lbr.act(holdemCore.observe(s, me))
      next = holdemCore.step(s, me === 0 ? [action, null] : [null, action])
    } else {
      const before = holdemCore.observe(s, me)
      const action = holdemCore.decodeAction(opts.victim(holdemCore.observe(s, actor), opts.victimRng))
      next = holdemCore.step(s, actor === 0 ? [action, null] : [null, action])
      lbr.observeOpponent(before, action)
    }
    if (next.hand !== hand || next.over) {
      deltas.push(next.net[me] - net)
      net = next.net[me]
      hand = next.hand
    }
    s = next
  }
  return deltas
}

export interface LbrSummary {
  hands: number
  /** Milli big blinds won per hand by the best responder. */
  mbbPerHand: number
  ci95: [number, number]
  /** Standard deviation of one hand, in big blinds. */
  sdBb: number
}

/** Mean and 95% interval of per-hand chip results, in milli big blinds. Hands are independent draws, so the interval is mean +/- 1.96 standard errors. */
export function summariseHands(chips: ArrayLike<number>): LbrSummary {
  const n = chips.length
  if (n < 2) throw new Error('lbr: need at least two hands for an interval')
  let sum = 0
  for (let i = 0; i < n; i++) sum += chips[i]!
  const mean = sum / n
  let ss = 0
  for (let i = 0; i < n; i++) ss += (chips[i]! - mean) ** 2
  const sd = Math.sqrt(ss / (n - 1))
  const se = sd / Math.sqrt(n)
  const toMbb = (x: number) => (x / BIG_BLIND) * 1000
  return { hands: n, mbbPerHand: toMbb(mean), ci95: [toMbb(mean - 1.959964 * se), toMbb(mean + 1.959964 * se)], sdBb: sd / BIG_BLIND }
}
