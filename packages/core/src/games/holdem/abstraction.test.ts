import { expect, test } from 'bun:test'
import {
  ALLIN,
  CALL,
  COARSE,
  FINE,
  FOLD,
  HALF,
  POT,
  Abstraction,
  abstractActions,
  canonicalKey,
  computeThresholds,
  enumerateBettingStates,
  exactEquity,
  flopEquity,
  turnEquity,
  streetEquity,
  EQUITY_VERSION,
  infoKey,
  parseInfoKey,
  preflopClass,
  raiseFraction,
  tableSizeEstimate,
  type BetSpot,
} from './abstraction'
import { harmonicProbLower, translateRaise } from './translate'
import { parseCards, makeCard } from './cards'
import { HoldemTable, abstractionMeta, encodeTable } from './table-format'
import { makeRng } from '../../rng'
import { Mccfr } from './mccfr'
import { holdemGame } from './holdem-game'

const small = (cfg = COARSE) => new Abstraction(cfg, computeThresholds(cfg, { samples: [300, 600, 600] }))

test('169 preflop classes with the right combo counts', () => {
  const counts = new Map<number, number>()
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) counts.set(preflopClass(a, b), (counts.get(preflopClass(a, b)) ?? 0) + 1)
  expect(counts.size).toBe(169)
  const sizes = [...counts.values()]
  expect(sizes.filter((n) => n === 6).length).toBe(13)
  expect(sizes.filter((n) => n === 4).length).toBe(78)
  expect(sizes.filter((n) => n === 12).length).toBe(78)
  expect(Math.max(...counts.keys())).toBe(168)
  expect(preflopClass(...(parseCards('As Ks') as [number, number]))).not.toBe(preflopClass(...(parseCards('As Kd') as [number, number])))
  expect(preflopClass(...(parseCards('As Ks') as [number, number]))).toBe(preflopClass(...(parseCards('Kh Ah') as [number, number])))
})

test('exact river and turn equity on known hands', () => {
  // Nut straight flush: nothing beats it.
  expect(exactEquity(parseCards('As Ks'), parseCards('Qs Js Ts 2c 3d'))).toBe(1)
  // The board is a royal flush: every hand ties.
  expect(exactEquity(parseCards('2c 3d'), parseCards('As Ks Qs Js Ts'))).toBe(0.5)
  const turn = exactEquity(parseCards('Ah Ad'), parseCards('2c 7d 9h Ks'))
  expect(turn).toBeGreaterThan(0.8)
  expect(turn).toBeLessThan(0.95)
})

test('flop equity is seeded, deterministic and the same for suit-relabelled spots', () => {
  const a = flopEquity(parseCards('As Ks'), parseCards('Qs 7d 2c'))
  const b = flopEquity(parseCards('As Ks'), parseCards('Qs 7d 2c'))
  expect(a).toBe(b)
  // Swap spades and hearts, clubs and diamonds: same spot up to suit names.
  const c = flopEquity(parseCards('Ah Kh'), parseCards('Qh 7c 2d'))
  expect(c).toBe(a)
  expect(canonicalKey(parseCards('As Ks'), parseCards('Qs 7d 2c'))).toBe(canonicalKey(parseCards('Ah Kh'), parseCards('Qh 7c 2d')))
  expect(canonicalKey(parseCards('As Ks'), parseCards('Qs 7d 2c'))).not.toBe(canonicalKey(parseCards('As Kd'), parseCards('Qs 7d 2c')))
  expect(a).toBeGreaterThan(0.5)
})

test('bucket function is deterministic, in range, monotone and uses the configured counts', () => {
  for (const cfg of [COARSE, FINE]) {
    const abs = small(cfg)
    for (let street = 1 as 1 | 2 | 3; street <= 3; street = (street + 1) as 1 | 2 | 3) {
      expect(abs.thresholds[street - 1]!.length).toBe(cfg.buckets[street - 1]! - 1)
      expect(abs.size(street)).toBe(cfg.buckets[street - 1]!)
      const cuts = abs.thresholds[street - 1]!
      for (let i = 1; i < cuts.length; i++) expect(cuts[i]!).toBeGreaterThanOrEqual(cuts[i - 1]!)
      let prev = -1
      for (let e = 0; e <= 100; e++) {
        const b = abs.bucketOfEquity(street, e / 100)
        expect(b).toBeGreaterThanOrEqual(prev)
        expect(b).toBeLessThan(cfg.buckets[street - 1]!)
        prev = b
      }
      expect(abs.bucketOfEquity(street, 0)).toBe(0)
      expect(abs.bucketOfEquity(street, 1)).toBe(cfg.buckets[street - 1]! - 1)
    }
    expect(abs.size(0)).toBe(169)
  }
  const abs = small()
  const hole = parseCards('Ad Kd')
  const board = parseCards('Qd 7c 2h Js')
  expect(abs.bucket(2, hole, board)).toBe(abs.bucket(2, hole, board))
  // Strong made hands land in a higher bucket than weak ones.
  expect(abs.bucket(3, parseCards('As Ah'), parseCards('Ad Ac 7s 8h 2c'))).toBeGreaterThan(abs.bucket(3, parseCards('2s 3h'), parseCards('Ad Kc 7s 8h 9c')))
  // Buckets spread over the range when sampled across random deals.
  const rng = makeRng(3)
  const used = new Set<number>()
  for (let i = 0; i < 1500; i++) {
    const d = Array.from({ length: 52 }, (_, k) => k)
    for (let k = 0; k < 7; k++) {
      const j = k + rng.int(52 - k)
      ;[d[k], d[j]] = [d[j]!, d[k]!]
    }
    used.add(abs.bucket(3, d.slice(0, 2), d.slice(2, 7)))
  }
  expect(used.size).toBeGreaterThanOrEqual(18)
})

test('thresholds that do not match the bucket counts are rejected', () => {
  expect(() => new Abstraction(COARSE, [[0.5], [0.5], [0.5]])).toThrow()
})

const preflopSb: BetSpot = { bet: 1, oppBet: 2, total: 1, oppTotal: 2, minTo: 4, maxTo: 100 }

test('abstract actions: preflop small blind, dedupe and all-in rules', () => {
  expect(abstractActions(preflopSb)).toEqual([
    { id: FOLD, to: -1 },
    { id: CALL, to: 2 },
    { id: HALF, to: 4 },
    { id: POT, to: 6 },
    { id: ALLIN, to: 100 },
  ])
  // Postflop, first to act, pot 40: half pot is 20, pot is 40.
  expect(abstractActions({ bet: 0, oppBet: 0, total: 20, oppTotal: 20, minTo: 2, maxTo: 80 }).map((a) => [a.id, a.to])).toEqual([
    [CALL, 0],
    [HALF, 20],
    [POT, 40],
    [ALLIN, 80],
  ])
  // Short stack: half pot and pot both exceed the stack, so only all-in remains.
  expect(abstractActions({ bet: 0, oppBet: 0, total: 90, oppTotal: 90, minTo: 2, maxTo: 10 }).map((a) => a.id)).toEqual([CALL, ALLIN])
  // Cannot raise: facing an all-in.
  expect(abstractActions({ bet: 10, oppBet: 100, total: 10, oppTotal: 100, minTo: 1, maxTo: 0 }).map((a) => a.id)).toEqual([FOLD, CALL])
  // A raise that would be the same chip amount for two ids is listed once.
  const tiny = abstractActions({ bet: 0, oppBet: 0, total: 2, oppTotal: 2, minTo: 2, maxTo: 98 })
  const tos = tiny.filter((a) => a.id >= HALF).map((a) => a.to)
  expect(new Set(tos).size).toBe(tos.length)
})

test('on-tree bets translate to themselves', () => {
  const spots: BetSpot[] = [
    preflopSb,
    { bet: 0, oppBet: 0, total: 20, oppTotal: 20, minTo: 2, maxTo: 80 },
    { bet: 6, oppBet: 20, total: 26, oppTotal: 40, minTo: 34, maxTo: 74 },
    { bet: 0, oppBet: 0, total: 2, oppTotal: 2, minTo: 2, maxTo: 98 },
  ]
  for (const spot of spots) {
    for (const a of abstractActions(spot)) {
      if (a.id === FOLD) continue
      for (const u of [0, 0.5, 0.999]) expect(translateRaise(spot, a.to, u).to).toBe(a.to)
    }
  }
})

test('off-tree bets translate to a bracketing size, never outside it', () => {
  const spot: BetSpot = { bet: 0, oppBet: 0, total: 20, oppTotal: 20, minTo: 2, maxTo: 80 }
  // Options: check (0), half pot (20), pot (40), all-in (80). A bet of 30 sits between 20 and 40.
  const lowPick = translateRaise(spot, 30, 0)
  const highPick = translateRaise(spot, 30, 0.9999)
  expect(lowPick.to).toBe(20)
  expect(highPick.to).toBe(40)
  // Smaller than half pot maps to check or half pot; bigger than all-in is impossible; just under all-in goes to pot or all-in.
  expect([0, 20]).toContain(translateRaise(spot, 5, 0.3).to)
  expect([40, 80]).toContain(translateRaise(spot, 70, 0.3).to)
  // Frequency over many draws follows the pseudo-harmonic probability.
  const fa = raiseFraction(spot, 20)
  const fb = raiseFraction(spot, 40)
  const fx = raiseFraction(spot, 30)
  const p = harmonicProbLower(fx, fa, fb)
  const rng = makeRng(9)
  let low = 0
  const n = 20000
  for (let i = 0; i < n; i++) if (translateRaise(spot, 30, rng.float()).to === 20) low++
  expect(Math.abs(low / n - p)).toBeLessThan(0.02)
})

test('pseudo-harmonic probability matches the published formula', () => {
  expect(harmonicProbLower(0.5, 0, 1)).toBeCloseTo(1 / 3, 12)
  expect(harmonicProbLower(1, 1, 3)).toBe(1)
  expect(harmonicProbLower(3, 1, 3)).toBe(0)
  expect(harmonicProbLower(2, 1, 3)).toBeCloseTo(((3 - 2) * (1 + 1)) / ((3 - 1) * (1 + 2)), 12)
})

test('info keys round trip', () => {
  const k = { street: 2 as const, bucket: 13, isButton: true, prior: 12, bet: 6, oppBet: 20 }
  expect(parseInfoKey(infoKey(k))).toEqual(k)
})

test('betting state counts are stable and bound the keys real training visits', () => {
  const states = enumerateBettingStates()
  expect(states.filter((s) => s.street === 0).length).toBe(72)
  expect(states.length).toBe(72 + 324 * 3)
  const est = tableSizeEstimate(COARSE)
  expect(est.total).toBe(72 * 169 + 324 * 20 * 3)
  expect(tableSizeEstimate(FINE).total).toBe(72 * 169 + 324 * 50 * 3)
  const known = new Set(states.map((s) => `${s.street}:${s.isButton ? 1 : 0}:${s.prior}:${s.bet}:${s.oppBet}`))
  const m = new Mccfr(holdemGame(small()), { plus: true, linear: true })
  m.run(400, 1)
  expect(m.nodes.size).toBeGreaterThan(500)
  for (const key of m.nodes.keys()) {
    const p = parseInfoKey(key)
    expect(known.has(`${p.street}:${p.isButton ? 1 : 0}:${p.prior}:${p.bet}:${p.oppBet}`), key).toBe(true)
    expect(p.bucket).toBeLessThan(p.street === 0 ? 169 : 20)
  }
})

test('the hold em game is zero-sum and every sampled hand ends', () => {
  const g = holdemGame(small())
  const rng = makeRng(5)
  let showdowns = 0
  for (let i = 0; i < 300; i++) {
    let n = g.sampleRoot(rng)
    let steps = 0
    while (!g.isTerminal(n)) {
      const acts = g.actions(n)
      expect(acts.length).toBeGreaterThan(0)
      n = g.child(n, acts[rng.int(acts.length)]!)
      expect(++steps).toBeLessThan(60)
    }
    expect(g.utility(n, 0) + g.utility(n, 1)).toBe(0)
    if (n.s.last?.showdown) showdowns++
  }
  expect(showdowns).toBeGreaterThan(20)
  void makeCard
})

test('turn equity counts the river: a 15-out draw buckets above a dead hand with the same high card', () => {
  const abs = small()
  const board = parseCards('2h 7h 9c Js')
  const draw = parseCards('5h 6h') // flush draw plus open-ended straight draw
  const dead = parseCards('5d 3c') // same board, nothing to draw to
  const eDraw = turnEquity(draw, board)
  expect(eDraw).toBe(turnEquity(draw, board))
  expect(streetEquity(2, draw, board)).toBe(turnEquity(draw, board))
  expect(streetEquity(2, dead, board)).toBe(turnEquity(dead, board))
  expect(eDraw).toBeGreaterThan(0.25)
  expect(eDraw).toBeGreaterThan(turnEquity(dead, board) + 0.15)
  expect(abs.bucket(2, draw, board)).toBeGreaterThan(abs.bucket(2, dead, board))
  // Suit-relabelled spot shares the sampled value.
  expect(turnEquity(parseCards('5s 6s'), parseCards('2s 7s 9c Jh'))).toBe(eDraw)
})

test('a table built with another equity definition is rejected', () => {
  const meta = abstractionMeta(new Abstraction(COARSE, [19, 19, 19].map((n) => Array.from({ length: n }, (_, i) => (i + 1) / 20))))
  const entries = [{ key: '0:3:1:0:0:0', mask: 0b10, probs: [0, 1, 0, 0, 0] }]
  expect(() => new HoldemTable(encodeTable({ abstraction: meta, iterations: 1 }, entries))).not.toThrow()
  expect(() => new HoldemTable(encodeTable({ abstraction: { ...meta, equityVersion: 'turn-exact-no-river' }, iterations: 1 }, entries))).toThrow(/equity definition/)
})
