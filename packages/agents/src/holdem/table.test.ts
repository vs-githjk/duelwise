import { beforeAll, expect, test } from 'bun:test'
import { gzipSync } from '@duelwise/core/src/gzip'
import { ACTION_WIDTH, Abstraction, COARSE, computeThresholds, infoKey } from '@duelwise/core/src/games/holdem/abstraction'
import { holdemCore } from '@duelwise/core/src/games/holdem/core'
import { holdemGame } from '@duelwise/core/src/games/holdem/holdem-game'
import { Mccfr, normalised } from '@duelwise/core/src/games/holdem/mccfr'
import { buildTable } from '@duelwise/core/src/games/holdem/cfr-main'
import { MATCH_HANDS } from '@duelwise/core/src/games/holdem/match'
import { abstractionMeta, encodeTable, quantise } from '@duelwise/core/src/games/holdem/table-format'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent, createHoldemAgent } from './agent'
import { loadTable, loadTableAsync, strategyFor } from './table'

let solver: Mccfr<any>
let abs: Abstraction
let bytes: Uint8Array

beforeAll(() => {
  abs = new Abstraction(COARSE, computeThresholds(COARSE, { samples: [300, 600, 600] }))
  solver = new Mccfr(holdemGame(abs), { plus: true, linear: true })
  solver.run(3000, 14)
  bytes = buildTable(solver, abs, 'test')
}, 60_000)

test('quantise keeps every probability within 1/255 and sums to 255', () => {
  const rng = makeRng(2)
  for (let i = 0; i < 2000; i++) {
    const mask = 1 + rng.int(31)
    const probs = Array.from({ length: ACTION_WIDTH }, () => (rng.int(3) === 0 ? 0 : rng.float()))
    const q = quantise(probs, mask)
    expect(q.reduce((s, x) => s + x, 0)).toBe(255)
    let total = 0
    let used = 0
    for (let a = 0; a < ACTION_WIDTH; a++) if (mask & (1 << a)) (total += probs[a]!), used++
    for (let a = 0; a < ACTION_WIDTH; a++) {
      if (!(mask & (1 << a))) expect(q[a]).toBe(0)
      else expect(Math.abs(q[a]! / 255 - (total > 0 ? probs[a]! / total : 1 / used))).toBeLessThan(1 / 255 + 1e-12)
    }
  }
})

test('snapshot to table to lookup reproduces every strategy within 1/255', () => {
  const t = loadTable(bytes)
  expect(t.entries).toBe(solver.nodes.size)
  expect(t.header.iterations).toBe(3000)
  for (const [key, node] of solver.nodes) {
    const want = normalised(node.sum, node.mask, ACTION_WIDTH)
    const got = strategyFor(key, t)
    expect(got.length).toBe(ACTION_WIDTH)
    expect(t.maskFor(key)).toBe(node.mask)
    for (let a = 0; a < ACTION_WIDTH; a++) expect(Math.abs(got[a]! - want[a]!)).toBeLessThanOrEqual(1 / 255 + 1e-6)
    expect(got.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 5)
  }
})

test('unknown keys return an empty strategy; the header carries the abstraction', () => {
  const t = loadTable(bytes)
  expect(strategyFor('9:9:9:9:9:9', t).length).toBe(0)
  expect(t.has('9:9:9:9:9:9')).toBe(false)
  const a = t.abstraction()
  expect(a.thresholds).toEqual(abs.thresholds)
  expect(a.config.buckets).toEqual([20, 20, 20])
  expect(t.header.priors[0]).toEqual([0])
  expect(t.header.priors[1]!.length).toBeGreaterThan(0)
})

test('gzip tables load sync and async, and corrupt tables are rejected', async () => {
  const gz = gzipSync(bytes)
  expect(gz.length).toBeLessThan(bytes.length)
  expect(loadTable(gz).entries).toBe(solver.nodes.size)
  expect((await loadTableAsync(gz)).entries).toBe(solver.nodes.size)
  expect(() => loadTable(bytes.slice(0, bytes.length - 3))).toThrow()
  const bad = bytes.slice()
  bad[0] = 0x58
  expect(() => loadTable(bad)).toThrow()
})

test('a hand-built table is read back exactly', () => {
  const key = infoKey({ street: 0, bucket: 5, isButton: true, prior: 0, bet: 1, oppBet: 2 })
  const t = loadTable(
    encodeTable(
      { abstraction: abstractionMeta(abs), iterations: 1 },
      [{ key, mask: 0b10011, probs: [0.5, 0.25, 0, 0, 0.25] }],
    ),
  )
  const s = strategyFor(key, t)
  expect(Array.from(s).map((x) => Math.round(x * 255))).toEqual([127, 64, 0, 0, 64])
})

function playMatch(agentSeat: 0 | 1, seed: number, purify: boolean): { misses: number; decisions: number; net: number } {
  const t = loadTable(bytes)
  const agent = createHoldemAgent(t, { purify, seed })
  agent.reset(seed)
  const rng = makeRng(seed + 1000)
  let s = holdemCore.init(seed)
  let decisions = 0
  let guard = 0
  while (!holdemCore.terminal(s)) {
    if (++guard > 5000) throw new Error('match did not end')
    const seat = holdemCore.toAct(s)[0]!
    let code: number
    if (seat === agentSeat) {
      const obs = holdemCore.observe(s, seat)
      code = (agent.policy as any).decide(obs, rng)
      decisions++
    } else {
      const legal = holdemCore.legal(s, seat).filter((a) => a.type !== 'concede')
      code = holdemCore.encodeAction(legal[rng.int(legal.length)]!)
    }
    const acts: [any, any] = [null, null]
    acts[seat] = holdemCore.decodeAction(code)
    s = holdemCore.step(s, acts) // throws on an illegal action
  }
  expect(s.net[0] + s.net[1]).toBe(0)
  expect(s.hand).toBe(MATCH_HANDS - 1)
  return { misses: agent.policy.misses, decisions, net: s.net[agentSeat] }
}

test('the agent plays full 30-hand matches with only legal actions, in both seats', () => {
  let decisions = 0
  let misses = 0
  for (const seed of [1, 2, 3, 4]) {
    for (const seat of [0, 1] as const) {
      for (const purify of [false, true]) {
        const r = playMatch(seat, seed, purify)
        decisions += r.decisions
        misses += r.misses
      }
    }
  }
  expect(decisions).toBeGreaterThan(200)
  // Most spots are in the table, even this barely trained one; the rest take the heuristic.
  expect(misses / decisions).toBeLessThan(0.5)
}, 60_000)

test('a table answers a human off-tree preflop raise through translation', () => {
  const t = loadTable(bytes)
  const agent = createHoldemAgent(t, { purify: false, seed: 1 })
  agent.reset(1)
  // Seat 1 is the big blind on hand 0. Seat 0 (button) raises to 5, which is off the abstract tree.
  let s = holdemCore.init(77)
  s = holdemCore.step(s, [{ type: 'raise', to: 5 }, null])
  const obs = holdemCore.observe(s, 1)
  const code = (agent.policy as any).decide(obs, makeRng(3))
  expect(holdemCore.legal(s, 1).some((a) => holdemCore.encodeAction(a) === code)).toBe(true)
  expect(agent.policy.misses).toBe(0)
})

test('createGameAgent falls back to a preview agent when no table is available, and is real with one', async () => {
  const preview = await createGameAgent('easy', { tableBase: 'http://127.0.0.1:1/none' })
  expect(preview.preview).toBe(true)
  const real = await createGameAgent('hard', { table: bytes })
  expect(real.preview).toBe(false)
  real.reset(5)
  const s = holdemCore.init(5)
  const code = (await real.act(holdemCore.observe(s, 0)))[0]!
  expect(holdemCore.legal(s, 0).some((a) => holdemCore.encodeAction(a) === code)).toBe(true)
  const champ = (await createGameAgent('champion', { table: bytes })) as any
  expect(champ.preview).toBe(false)
})
