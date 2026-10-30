import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { holdemCore } from '@duelwise/core/src/games/holdem/core'
import { preflopClass } from '@duelwise/core/src/games/holdem/abstraction'
import { parseCards } from '@duelwise/core/src/games/holdem/cards'
import { rank7 } from '@duelwise/core/src/games/holdem/evaluator'
import { makeRng } from '@duelwise/core/src/rng'
import { HOLDEM_LEVELS, HoldemPolicy, beginnerProbs, createGameAgent, handPercentile, shoveFloorProbs, callBiasProbs, pruneProbs } from './agent'
import { loadTable } from './table'
import type { HoldemTable } from './table'

const V1 = join(import.meta.dir, '..', '..', '..', '..', 'apps', 'web', 'public', 'agents', 'holdem', 'v1')
let table: HoldemTable

beforeAll(() => {
  table = loadTable(new Uint8Array(readFileSync(join(V1, 'hard.bin.gz'))))
})

/** Seat 1 (the big blind) facing a raise to `to` from the button, before the flop. */
function facingRaise(to: number) {
  const s = holdemCore.step(holdemCore.init(21), [{ type: 'raise', to }, null])
  return holdemCore.observe(s, 1)
}

function mixture(policy: HoldemPolicy, obs: ReturnType<typeof facingRaise>): Map<number, number> {
  const out = new Map<number, number>()
  for (const b of policy.branches(obs, null)) {
    const total = b.probs.reduce((a, x) => a + x, 0)
    b.options.forEach((o, i) => out.set(o.id, (out.get(o.id) ?? 0) + (b.weight * b.probs[i]!) / total))
  }
  return out
}

/** How often decide plays each option, keyed like `optionKey`. */
function observed(policy: HoldemPolicy, obs: ReturnType<typeof facingRaise>, n: number): Map<string, number> {
  const counts = new Map<string, number>()
  const rng = makeRng(77)
  for (let i = 0; i < n; i++) {
    policy.reset()
    const a = holdemCore.decodeAction(policy.decide(obs, rng))
    const key = a.type === 'raise' ? `raise ${a.to}` : a.type
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

const optionKey = (o: { id: number; to: number }): string => (o.id === 0 ? 'fold' : o.id === 1 ? 'call' : `raise ${o.to}`)

test('small action probabilities are pruned and renormalised', () => {
  expect(pruneProbs([0.94, 0.04, 0.02])).toEqual([1, 0, 0])
  expect(pruneProbs([0, 0])).toEqual([1, 0])
  expect(pruneProbs([0.5, 0.5])).toEqual([0.5, 0.5])
})

test('premium protection covers QQ and better and suited AK against shoves, and TT or JJ against a min raise', async () => {
  for (const level of ['hard', 'champion'] as const) {
    const bytes = new Uint8Array(readFileSync(join(V1, `${level}.bin.gz`)))
    const agent = await createGameAgent(level, { table: bytes })
    const policy = (agent as typeof agent & { policy: HoldemPolicy }).policy
    for (const cards of ['Ac Ad', 'Kc Kd', 'Qc Qd', 'Ac Kc']) {
      const obs = { ...facingRaise(100), hole: parseCards(cards) }
      expect(mixture(policy, obs).get(0) ?? 0).toBe(0)
      expect(observed(policy, obs, 100).get('fold') ?? 0).toBe(0)
    }
    const unprotected = new HoldemPolicy(loadTable(bytes), false, { premiumProtection: false })
    for (const [cards, open] of (level === 'hard' ? [['Jc Jd', 18], ['Tc Td', 18]] : [['Jc Jd', 16], ['Tc Td', 16]]) as Array<[string, number]>) {
      const initial = holdemCore.init(21)
      const raised = holdemCore.step(initial, [{ type: 'raise', to: open }, null])
      const reraised = holdemCore.step(raised, [null, { type: 'raise', to: open * 2 - 2 }])
      const obs = { ...holdemCore.observe(reraised, 0), hole: parseCards(cards) }
      const memory = { hand: obs.hand, street: obs.street, oppBet: 2, myBet: open }
      const fold = (candidate: HoldemPolicy) => candidate.branches(obs, memory).reduce((sum, branch) => sum + branch.weight * (branch.probs[branch.options.findIndex((option) => option.id === 0)] ?? 0), 0)
      expect(fold(unprotected)).toBeGreaterThan(0)
      expect(fold(policy)).toBe(0)
    }
  }
})

test('pruned Champion never opens all-in with offsuit trash, seed 21', async () => {
  const bytes = new Uint8Array(readFileSync(join(V1, 'champion.bin.gz')))
  const agent = await createGameAgent('champion', { table: bytes })
  const policy = (agent as typeof agent & { policy: HoldemPolicy }).policy
  const initial = holdemCore.observe(holdemCore.init(21), 0)
  for (const high of '345678') for (const low of '2345678'.slice(0, '2345678'.indexOf(high))) {
    const obs = { ...initial, hole: parseCards(`${high}c ${low}d`) }
    expect(mixture(policy, obs).get(4) ?? 0).toBe(0)
  }
})

test('branches describe what decide does: an off-tree raise reads as a mixture of two table sizes and decide follows it', () => {
  const obs = facingRaise(9)
  const policy = new HoldemPolicy(table, false)
  const branches = policy.branches(obs, null)
  expect(branches.length).toBe(2)
  expect(branches.reduce((a, b) => a + b.weight, 0)).toBeCloseTo(1, 9)
  const expected = mixture(policy, obs)
  const counts = observed(policy, obs, 3000)
  const total = [...counts.values()].reduce((a, x) => a + x, 0)
  for (const o of branches[0]!.options) {
    expect(Math.abs((counts.get(optionKey(o)) ?? 0) / total - expected.get(o.id)!)).toBeLessThan(0.035)
  }
})

test('an on-tree raise is read one way only', () => {
  const policy = new HoldemPolicy(table, false)
  const onTree = policy.branches(facingRaise(9), null)[0]!.options.find((o) => o.id === 3)
  expect(onTree).toBeDefined()
})

test('a purified policy puts all its weight on one option and plays it', () => {
  const obs = facingRaise(9)
  const policy = new HoldemPolicy(table, true)
  for (const b of policy.branches(obs, null)) expect(b.probs.filter((p) => p > 0).length).toBe(1)
  const counts = observed(policy, obs, 200)
  expect(counts.size).toBeLessThanOrEqual(2)
})

test('exploration mixes in uniform play and decide uses it at that rate', () => {
  const obs = facingRaise(9)
  const policy = new HoldemPolicy(table, true, { explore: 0.5 })
  for (const b of policy.branches(obs, null)) {
    const total = b.probs.reduce((a, x) => a + x, 0)
    expect(total).toBeCloseTo(1, 9)
    for (const p of b.probs) expect(p).toBeGreaterThanOrEqual(0.5 / b.options.length - 1e-12)
  }
  // Purified plus half random: the table's choice gets about half plus its uniform share, every other option about its uniform share.
  const counts = observed(policy, obs, 4000)
  expect(counts.size).toBeGreaterThanOrEqual(3)
  expect(() => new HoldemPolicy(table, false, { explore: 1.5 })).toThrow()
})

test('every level has settings, and only Easy plays the beginner mix, with no random play', () => {
  expect(HOLDEM_LEVELS.easy.beginner).toBe(true)
  expect(HOLDEM_LEVELS.easy.explore).toBe(0)
  for (const l of ['medium', 'hard', 'champion'] as const) {
    expect(HOLDEM_LEVELS[l].explore).toBe(0)
    expect(HOLDEM_LEVELS[l].beginner).toBe(false)
  }
  // KA4: Champion plays the mixed strategy (the purified one was far more exploitable), and the middle levels have a shove floor.
  expect(HOLDEM_LEVELS.champion.purify).toBe(false)
  for (const l of ['medium', 'hard'] as const) expect(HOLDEM_LEVELS[l].shoveFloor).toBeGreaterThan(0)
  for (const l of ['easy', 'champion'] as const) expect(HOLDEM_LEVELS[l].shoveFloor).toBe(0)
  // The call dial cuts the levels below Hard: Medium and Easy call more, Hard and Champion play the table.
  expect(HOLDEM_LEVELS.medium.callBias).toBeGreaterThan(0)
  expect(HOLDEM_LEVELS.easy.callBias).toBeGreaterThan(0)
  expect(HOLDEM_LEVELS.hard.callBias).toBe(0)
  expect(HOLDEM_LEVELS.champion.callBias).toBe(0)
})

test('callBiasProbs turns that share of every fold and raise into a call and keeps the total', () => {
  const ids = [0, 1, 2, 3, 4]
  const probs = [0.2, 0.2, 0.2, 0.2, 0.2]
  const out = callBiasProbs(probs, ids, 0.5)
  expect(out.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12)
  expect(out[1]).toBeCloseTo(0.2 + 0.4, 12)
  for (const i of [0, 2, 3, 4]) expect(out[i]).toBeCloseTo(0.1, 12)
  expect(callBiasProbs(probs, ids, 0)).toEqual(probs)
  expect(callBiasProbs(probs, ids, 1)[1]).toBeCloseTo(1, 12)
  // No call option: untouched.
  expect(callBiasProbs([0.5, 0.5], [0, 2], 0.5)).toEqual([0.5, 0.5])
  expect(() => new HoldemPolicy(table, false, { callBias: 1.5 })).toThrow()
})

test('the published tables load through the level factory and play a whole match', async () => {
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    const bytes = new Uint8Array(readFileSync(join(V1, `${level}.bin.gz`)))
    const agent = await createGameAgent(level, { table: bytes })
    expect(agent.preview).toBe(false)
    agent.reset(5)
    let s = holdemCore.init(5)
    while (!holdemCore.terminal(s)) {
      const seat = s.actor
      const code = seat === 1 ? (await agent.act(holdemCore.observe(s, seat)))[0]! : holdemCore.encodeAction({ type: 'call' })
      const a = holdemCore.decodeAction(code)
      s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
    }
    expect(s.net[0] + s.net[1]).toBe(0)
  }
}, 60_000)

// ---- Easy plays like a loose-passive beginner (JA4) ----

/** Preflop equity against a random hand by Monte Carlo: an ordering of starting hands that does not use the agent's own strength rule. */
function preflopEquity(hole: number[], seed: number, n = 600): number {
  const rng = makeRng(seed)
  const dead = new Set(hole)
  const live: number[] = []
  for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c)
  let score = 0
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 7; k++) {
      const j = k + rng.int(live.length - k)
      ;[live[k], live[j]] = [live[j]!, live[k]!]
    }
    const board = live.slice(2, 7)
    const mine = rank7([...hole, ...board])
    const theirs = rank7([live[0]!, live[1]!, ...board])
    score += mine > theirs ? 1 : mine === theirs ? 0.5 : 0
  }
  return score / n
}

test('Easy plays a loose-passive beginner mix: no random shoves from weak hands, never folds a premium preflop', () => {
  const easyTable = loadTable(new Uint8Array(readFileSync(join(V1, 'easy.bin.gz'))))
  const s = HOLDEM_LEVELS.easy
  const policy = new HoldemPolicy(easyTable, s.purify, { explore: s.explore, beginner: s.beginner })
  const deals = 900
  const hands: { obs: ReturnType<typeof facingRaise>; eq: number }[] = []
  for (let seed = 1; seed <= deals; seed++) {
    const real = holdemCore.observe(holdemCore.step(holdemCore.init(seed), [{ type: 'raise', to: 4 }, null]), 1)
    hands.push({ obs: real, eq: preflopEquity([...real.hole], seed) })
  }
  const sorted = hands.map((h) => h.eq).sort((a, b) => a - b)
  const low = sorted[Math.floor(deals * 0.3)]!
  const high = sorted[Math.floor(deals * 0.95)]!
  const prob = (obs: ReturnType<typeof facingRaise>, ids: number[]): number => {
    let p = 0
    for (const b of policy.branches(obs, null)) {
      const total = b.probs.reduce((a, x) => a + x, 0)
      b.options.forEach((o, i) => {
        if (ids.includes(o.id)) p += (b.weight * b.probs[i]!) / total
      })
    }
    return p
  }
  const weak = hands.filter((h) => h.eq <= low)
  // The top 5 percent, re-measured with many more samples for the hands near the cut so sampling noise cannot put a borderline hand in.
  const near = hands.filter((h) => h.eq >= high - 0.05).map((h, i) => ({ ...h, eq: preflopEquity([...h.obs.hole], 9000 + i, 6000) }))
  const cut = [...near.map((h) => h.eq)].sort((a, b) => a - b)[Math.max(0, near.length - Math.ceil(deals * 0.05))]!
  const premium = near.filter((h) => h.eq >= cut)
  expect(weak.length).toBeGreaterThan(200)
  expect(premium.length).toBeGreaterThan(30)
  const shove = weak.reduce((a, h) => a + prob(h.obs, [4]), 0) / weak.length
  expect(shove).toBeLessThan(0.05)
  for (const h of premium) expect(prob(h.obs, [0])).toBe(0)
  // Loose: across all hands it still calls far more than a table-driven player folds.
  const fold = hands.reduce((a, h) => a + prob(h.obs, [0]), 0) / deals
  const hardPolicy = new HoldemPolicy(table, false)
  const hardFold = hands.reduce((a, h) => {
    let p = 0
    for (const b of hardPolicy.branches(h.obs, null)) {
      const total = b.probs.reduce((x, y) => x + y, 0)
      b.options.forEach((o, i) => {
        if (o.id === 0) p += (b.weight * b.probs[i]!) / total
      })
    }
    return a + p
  }, 0) / deals
  expect(fold).toBeLessThan(hardFold)
})

test('beginnerProbs keeps the total, moves mass only onto call, and treats weak and premium hands as stated', () => {
  const ids = [0, 1, 2, 3, 4]
  const probs = [0.2, 0.2, 0.2, 0.2, 0.2]
  for (const street of [0, 1, 2, 3]) {
    const buckets = street === 0 ? 169 : 8
    for (let b = 0; b < buckets; b++) {
      const out = beginnerProbs(probs, ids, street, b, buckets)
      expect(out.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12)
      for (const i of [0, 2, 3, 4]) expect(out[i]!).toBeLessThanOrEqual(probs[i]! + 1e-12)
      const pct = handPercentile(street, b, buckets)
      if (pct < 0.3) expect(out[4]).toBe(0)
      if (street === 0 && pct >= 0.88) expect(out[0]).toBe(0)
    }
  }
  // No call option (nothing to move onto): untouched.
  expect(beginnerProbs([0.5, 0.5], [0, 2], 1, 3, 8)).toEqual([0.5, 0.5])
})

// ---- the weakest preflop hands are never shoved (KA4) ----

test('shoveFloorProbs moves the shove of a weak preflop hand onto fold (call when folding is not an option) and touches nothing else', () => {
  const ids = [0, 1, 2, 3, 4]
  const probs = [0.1, 0.2, 0.2, 0.2, 0.3]
  for (let b = 0; b < 169; b++) {
    const out = shoveFloorProbs(probs, ids, 0, b, 169, 0.25)
    expect(out.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12)
    if (handPercentile(0, b, 169) < 0.25) {
      expect(out[4]).toBe(0)
      expect(out[0]).toBeCloseTo(0.4, 12)
      expect(out.slice(1, 4)).toEqual(probs.slice(1, 4))
    } else expect(out).toEqual(probs)
  }
  // Later streets are never changed.
  expect(shoveFloorProbs(probs, ids, 2, 0, 8, 0.25)).toEqual(probs)
  // No fold available: the mass goes onto call.
  const noFold = shoveFloorProbs([0.5, 0.2, 0.3], [1, 3, 4], 0, 0, 169, 0.25)
  expect(noFold[2]).toBe(0)
  expect(noFold[0]).toBeCloseTo(0.8, 12)
  // A floor of zero is a no-op.
  expect(shoveFloorProbs(probs, ids, 0, 0, 169, 0)).toEqual(probs)
})

test('Medium and Hard never shove the weakest preflop hands, where the raw table does (3-2 offsuit)', async () => {
  const mediumBytes = new Uint8Array(readFileSync(join(V1, 'medium.bin.gz')))
  const mediumTable = loadTable(mediumBytes)
  let rawShoves = 0
  let seen = 0
  for (let seed = 1; seed <= 4000 && seen < 40; seed++) {
    for (const first of [{ type: 'raise', to: 4 }, { type: 'raise', to: 12 }] as const) {
      const obs = holdemCore.observe(holdemCore.step(holdemCore.init(seed), [first, null]), 1)
      if (handPercentile(0, preflopClass(obs.hole[0]!, obs.hole[1]!), 169) >= 0.25 || preflopEquity([...obs.hole], seed, 300) > 0.45) continue
      seen++
      const sum = (policy: HoldemPolicy): number =>
        policy.branches(obs, null).reduce((a, b) => a + (b.weight * b.probs.filter((_, i) => b.options[i]!.id === 4).reduce((x, y) => x + y, 0)) / b.probs.reduce((x, y) => x + y, 0), 0)
      rawShoves += sum(new HoldemPolicy(mediumTable, false))
      for (const level of ['medium', 'hard'] as const) {
        const s = HOLDEM_LEVELS[level]
        const t = level === 'medium' ? mediumTable : table
        expect(sum(new HoldemPolicy(t, s.purify, { shoveFloor: s.shoveFloor }))).toBeLessThan(0.03)
      }
    }
  }
  expect(seen).toBeGreaterThan(20)
  // The floor is doing something: the raw table does shove some of these.
  expect(rawShoves).toBeGreaterThan(0.2)
})
