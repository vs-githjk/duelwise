import { beforeAll, expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import { Abstraction, COARSE, FOLD, CALL, abstractActions, computeThresholds, parseInfoKey, type AbstractAction, type BetSpot } from './abstraction'
import { abstractBestResponse, bucketDeals, evaluateStrategy, sampleDeals, type BucketedDeals, type StrategyLookup } from './abstract-br'
import { HOLDEM_BOT_KINDS, createBot } from './baselines'
import { holdemCore, type HoldemObservation } from './core'
import { LbrAgent, playLbrMatch, summariseHands, type LbrVictim, type VictimBranch } from './lbr'
import { holdemGame } from './holdem-game'
import { Mccfr, normalised } from './mccfr'
import { buildTable } from './cfr-main'
import { cardRank } from './cards'
import { decodeTable } from './table-format'

function spotOf(obs: HoldemObservation): BetSpot {
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

/** A victim that follows `pick(obs, options)`: the index of the one option it always takes. */
function fixedVictim(pick: (obs: HoldemObservation, options: AbstractAction[]) => number): LbrVictim {
  return {
    branches(obs): VictimBranch[] {
      const options = abstractActions(spotOf(obs))
      const probs = options.map(() => 0)
      probs[pick(obs, options)] = 1
      return [{ weight: 1, options, probs }]
    },
  }
}

const callStation = fixedVictim((_, options) => options.findIndex((o) => o.id === CALL))

function lbrAgainst(victimModel: LbrVictim, kind: (typeof HOLDEM_BOT_KINDS)[number], matches: number, seed: number): number[] {
  const bot = createBot(kind)
  const chips: number[] = []
  for (let m = 0; m < matches; m++) {
    const lbr = new LbrAgent(victimModel, (m % 2) as 0 | 1, { seed: seed + m })
    chips.push(...playLbrMatch({ seed: seed + m, lbr, victim: (obs, rng) => bot.decide(obs, rng), victimRng: makeRng(seed * 31 + m) }))
  }
  return chips
}

test('LBR beats a calling station by a wide margin and reports a confidence interval', () => {
  const chips = lbrAgainst(callStation, 'always-call', 24, 5)
  expect(chips.length).toBe(24 * 30)
  const s = summariseHands(chips)
  expect(s.hands).toBe(720)
  expect(s.mbbPerHand).toBeGreaterThan(1500)
  expect(s.ci95[0]).toBeGreaterThan(500)
  expect(s.ci95[0]).toBeLessThan(s.mbbPerHand)
  expect(s.ci95[1]).toBeGreaterThan(s.mbbPerHand)
})

test('LBR is deterministic for a seed', () => {
  expect(lbrAgainst(callStation, 'always-call', 3, 9)).toEqual(lbrAgainst(callStation, 'always-call', 3, 9))
})

test('the interval is the mean plus or minus 1.96 standard errors, in milli big blinds', () => {
  const s = summariseHands([2, -2, 4, 0, 6, -4])
  expect(s.mbbPerHand).toBeCloseTo((1 / 2) * 1000, 6)
  // Mean 1, deviations 1, -3, 3, -1, 5, -5.
  const sd = Math.sqrt([1, -3, 3, -1, 5, -5].reduce((a, x) => a + x * x, 0) / 5)
  expect(s.ci95[1] - s.mbbPerHand).toBeCloseTo(((1.959964 * sd) / Math.sqrt(6) / 2) * 1000, 4)
})

test('the belief follows the victim: after a pot raise from a victim that raises only pairs, only pairs remain', () => {
  const pairsRaise = fixedVictim((obs, options) => {
    const pair = cardRank(obs.hole[0]!) === cardRank(obs.hole[1]!)
    const raise = options.findIndex((o) => o.id === 3)
    return pair && raise >= 0 ? raise : options.findIndex((o) => o.id === CALL)
  })
  let s = holdemCore.init(3)
  // Seat 0 (the button) acts first before the flop: the best responder sits in seat 1.
  const lbr = new LbrAgent(pairsRaise, 1, { seed: 1 })
  lbr.reset(1)
  const before = holdemCore.observe(s, 1)
  const victimView = { ...holdemCore.observe(s, 0), hole: [0, 1] }
  const raise = abstractActions(spotOf(victimView)).find((o) => o.id === 3)!
  s = holdemCore.step(s, [{ type: 'raise', to: raise.to }, null])
  lbr.observeOpponent(before, { type: 'raise', to: raise.to })
  const w = lbr.belief()
  let live = 0
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const wt = w[LbrAgent.comboIndex(a, b)]!
      if (wt > 0) {
        live++
        expect(cardRank(a)).toBe(cardRank(b))
      }
    }
  }
  expect(live).toBeGreaterThan(0)
  expect(lbr.resets).toBe(0)
})

test('an action no hand can explain resets the belief instead of emptying it', () => {
  const alwaysFold = fixedVictim((_, options) => options.findIndex((o) => o.id === FOLD))
  const lbr = new LbrAgent(alwaysFold, 1, { seed: 1 })
  lbr.reset(1)
  const s = holdemCore.init(3)
  lbr.observeOpponent(holdemCore.observe(s, 1), { type: 'call' })
  expect(lbr.resets).toBe(1)
  expect(lbr.belief().some((x) => x > 0)).toBe(true)
})

test('the baseline bots play legal, different games', () => {
  const results = new Map<string, number>()
  for (const kind of HOLDEM_BOT_KINDS) {
    const bot = createBot(kind)
    const rng = makeRng(4)
    let s = holdemCore.init(8)
    let raises = 0
    let folds = 0
    while (!holdemCore.terminal(s)) {
      const seat = holdemCore.toAct(s)[0]!
      const a = holdemCore.decodeAction(bot.decide(holdemCore.observe(s, seat), rng))
      if (a.type === 'raise') raises++
      if (a.type === 'fold') folds++
      s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
    }
    results.set(kind, raises * 100 + folds)
  }
  expect(results.get('always-call')).toBe(0)
  expect(Math.floor(results.get('pot-raiser')! / 100)).toBeGreaterThan(5)
  expect(results.get('pot-raiser')! % 100).toBe(0)
  expect(results.get('equity-threshold')! % 100).toBeGreaterThan(0)
})

// ---------- tables ----------

let abs: Abstraction

beforeAll(() => {
  abs = new Abstraction(COARSE, computeThresholds(COARSE, { samples: [300, 600, 600] }))
}, 60_000)

test('a quantised table matches the solver it came from within 1/255 at every information set', () => {
  const solver = new Mccfr(holdemGame(abs), { plus: true, linear: true })
  solver.run(2000, 14)
  const table = decodeTable(buildTable(solver, abs, 'test'))
  expect(table.entries).toBe(solver.nodes.size)
  for (const [key, node] of solver.nodes) {
    const exact = normalised(node.sum, node.mask, 5)
    const got = table.strategyFor(key)
    expect(table.maskFor(key)).toBe(node.mask)
    for (let a = 0; a < 5; a++) {
      if (node.mask & (1 << a)) expect(Math.abs(got[a]! - exact[a]!)).toBeLessThanOrEqual(1 / 255 + 1e-9)
      else expect(got[a]).toBe(0)
    }
  }
}, 60_000)

// ---------- in-abstraction best response ----------

const foldToBets: StrategyLookup = (key) => {
  const k = parseInfoKey(key)
  const probs = [0, 0, 0, 0, 0]
  probs[k.oppBet > k.bet ? FOLD : CALL] = 1
  return { mask: 31, probs }
}

test('in-abstraction best response is exact where the answer is known: a strategy that folds to every bet loses its blind', () => {
  // Fitted and scored on the same deals, so every information set the scoring reaches was seen by the fit.
  const deals = bucketDeals(sampleDeals(150, 1), abs)
  const r = abstractBestResponse(foldToBets, deals, deals)
  // The button wins the big blind (2 chips = 1000 mbb), the big blind wins the small blind (1 chip = 500 mbb).
  expect(r.seatMbb[0]).toBeCloseTo(1000, 3)
  expect(r.seatMbb[1]).toBeCloseTo(500, 3)
  expect(r.heldOutMbb).toBeCloseTo(750, 3)
  expect(r.unknownShare).toBe(0)
}, 60_000)

test('a strategy at keys it does not hold is counted and played uniformly', () => {
  const fit = bucketDeals(sampleDeals(100, 3), abs)
  const score = bucketDeals(sampleDeals(100, 4), abs)
  const r = abstractBestResponse(() => null, fit, score)
  expect(r.unknownShare).toBeCloseTo(1, 6)
  expect(r.heldOutMbb).toBeGreaterThan(0)
}, 60_000)

test('the held-out value is a fair estimate: fitting on the scoring deals only raises it', () => {
  const a = bucketDeals(sampleDeals(120, 5), abs)
  const b = bucketDeals(sampleDeals(120, 6), abs)
  const callAll: StrategyLookup = () => ({ mask: 31, probs: [0, 1, 0, 0, 0] })
  const cross = abstractBestResponse(callAll, a, b)
  const same = abstractBestResponse(callAll, b, b)
  expect(cross.heldOutCi95[0]).toBeLessThan(cross.heldOutMbb)
  expect(same.heldOutMbb).toBeGreaterThanOrEqual(cross.heldOutMbb - 1e-6)
  expect(cross.heldOutMbb).toBeGreaterThan(0)
}, 60_000)

test('showdowns pay the right seat: a fixed shove-with-the-strong-river-bucket policy wins against a calling station on hand-built deals', () => {
  // Same bucket on every street but the river. Deal 0: seat 0 holds the strong river bucket and wins; deal 1: seat 0 holds the weak one and loses.
  const deals: BucketedDeals = {
    n: 2,
    bucket: Int16Array.from([5, 3, 3, 19, 7, 3, 3, 0, 5, 3, 3, 0, 7, 3, 3, 19]),
    showdown: Int8Array.from([1, -1]),
  }
  const callAll: StrategyLookup = () => ({ mask: 31, probs: [0, 1, 0, 0, 0] })
  // Preflop limp, flop and turn checks, the big blind checks the river: the button's turn is after seven calls (two before the flop, two on each later street but the river's one).
  const policy = new Map([['1.1.1.1.1.1.1.|19', 4]])
  // Strong hand shoves and is called: +100 chips. Weak hand checks down the 2-chip pot and loses it: -2. Mean 49 chips = 24500 mbb.
  expect(evaluateStrategy(deals, callAll, 0, policy)).toBeCloseTo(24500, 6)
  // Without the shove the two deals cancel: +2 and -2.
  expect(evaluateStrategy(deals, callAll, 0, new Map())).toBeCloseTo(0, 6)
})
