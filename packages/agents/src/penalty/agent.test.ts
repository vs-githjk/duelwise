import { describe, expect, test } from 'bun:test'
import { GOAL_PER_MILLE, penaltyCore, type KickView, type PenaltyObs, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { choosePenaltyAction, createGameAgent } from './agent'
import { EQ_KEEPER, EQ_SHOOTER } from './levels'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

function view(byMe: boolean, zone: Zone, dive: Zone): KickView {
  return { byMe, zone, dive, outcome: zone === dive ? 'save' : 'wide' }
}

function obs(role: 'shooter' | 'keeper', kicks: KickView[] = []): PenaltyObs {
  const mine = kicks.filter((k) => k.byMe).length
  return {
    seat: 0,
    role,
    round: Math.floor(kicks.length / 2) + 1,
    sudden: false,
    goals: [0, 0],
    taken: [mine, kicks.length - mine],
    kicks,
    over: false,
  }
}

/** Draw `n` actions from one seeded rng, same obs and salt each time. */
function draws(level: Level, o: PenaltyObs, n: number, salt = 7, seed = 11): [number, number, number] {
  const rng = makeRng(seed)
  const c: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < n; i++) c[choosePenaltyAction(level, o, rng, salt)]++
  return c
}

/** Fictitious play on the goal table, the same way the sim found its equilibrium. */
function fictitiousPlay(): { s: number[]; k: number[] } {
  const M = GOAL_PER_MILLE.map((r) => r.map((x) => x / 1000))
  const sc = [1, 1, 1]
  const kc = [1, 1, 1]
  for (let t = 0; t < 400000; t++) {
    const sv = [0, 1, 2].map((s) => [0, 1, 2].reduce((a, k) => a + M[s]![k]! * kc[k]!, 0))
    const kv = [0, 1, 2].map((k) => [0, 1, 2].reduce((a, s) => a + M[s]![k]! * sc[s]!, 0))
    sc[sv.indexOf(Math.max(...sv))]!++
    kc[kv.indexOf(Math.min(...kv))]!++
  }
  const norm = (a: number[]) => a.map((x) => x / (a[0]! + a[1]! + a[2]!))
  return { s: norm(sc), k: norm(kc) }
}

describe('equilibrium constants', () => {
  test('match fictitious play on the goal table within 0.01', () => {
    const { s, k } = fictitiousPlay()
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(EQ_SHOOTER[i]! - s[i]!)).toBeLessThan(0.01)
      expect(Math.abs(EQ_KEEPER[i]! - k[i]!)).toBeLessThan(0.01)
    }
    expect(EQ_SHOOTER.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
    expect(EQ_KEEPER.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
  })
})

describe('every level', () => {
  const histories: KickView[][] = [
    [],
    [view(true, 0, 2)],
    [view(false, 2, 1), view(true, 1, 0), view(false, 0, 0)],
    [view(true, 2, 2), view(false, 1, 0), view(true, 0, 1), view(false, 0, 2), view(true, 2, 0)],
  ]
  for (const level of LEVELS) {
    for (const role of ['shooter', 'keeper'] as const) {
      test(`${level} returns 0, 1 or 2 as ${role}`, () => {
        const rng = makeRng(5)
        for (const h of histories) {
          for (let i = 0; i < 50; i++) {
            const a = choosePenaltyAction(level, obs(role, h), rng, i)
            expect([0, 1, 2]).toContain(a)
          }
        }
      })
    }
  }

  test('throws once the shootout is over', () => {
    const o = { ...obs('shooter'), role: null, over: true } as PenaltyObs
    expect(() => choosePenaltyAction('easy', o, makeRng(1), 0)).toThrow()
  })

  test('is pure: same level, obs, rng state and salt give the same action, and nothing is kept between calls', () => {
    const hist = [view(false, 0, 2), view(true, 2, 0), view(false, 0, 1), view(true, 1, 1)]
    for (const level of LEVELS) {
      for (const role of ['shooter', 'keeper'] as const) {
        const o = obs(role, hist)
        const first: number[] = []
        const rngA = makeRng(99)
        for (let i = 0; i < 40; i++) first.push(choosePenaltyAction(level, o, rngA, 1234))
        // Interleave calls with other levels, other observations and other salts, then replay from a fresh rng.
        const noise = makeRng(3)
        for (const l of LEVELS) choosePenaltyAction(l, obs('shooter', [view(true, 1, 1)]), noise, 55)
        const second: number[] = []
        const rngB = makeRng(99)
        for (let i = 0; i < 40; i++) second.push(choosePenaltyAction(level, o, rngB, 1234))
        expect(second).toEqual(first)
        // One call leaves the observation alone.
        expect(JSON.stringify(o)).toBe(JSON.stringify(obs(role, hist)))
      }
    }
  })

  test('Sable ignores the salt (it reads habits only); the others use it for a favourite side', () => {
    const o = obs('keeper', [view(false, 0, 1), view(true, 2, 0)])
    const a: number[] = []
    const b: number[] = []
    const r1 = makeRng(8)
    const r2 = makeRng(8)
    for (let i = 0; i < 100; i++) {
      a.push(choosePenaltyAction('champion', o, r1, 1))
      b.push(choosePenaltyAction('champion', o, r2, 2))
    }
    expect(a).toEqual(b)
    const pipSides = new Set<number>()
    for (let salt = 0; salt < 40; salt++) {
      const c = draws('easy', obs('shooter'), 200, salt)
      pipSides.add(c[0] > c[2] ? 0 : 2)
    }
    expect(pipSides.size).toBe(2)
  })
})

describe('Pip', () => {
  test('never picks the middle and uses one side about 75% of the time, in both roles', () => {
    for (const role of ['shooter', 'keeper'] as const) {
      for (const salt of [1, 2, 3, 4, 5, 6]) {
        const c = draws('easy', obs(role), 2000, salt)
        expect(c[1]).toBe(0)
        const share = Math.max(c[0], c[2]) / 2000
        expect(share).toBeGreaterThan(0.72)
        expect(share).toBeLessThan(0.78)
      }
    }
  })

  test('is not moved by what happened', () => {
    const hist = [view(false, 0, 0), view(true, 0, 0), view(false, 0, 0)]
    expect(draws('easy', obs('shooter', hist), 500, 9)).toEqual(draws('easy', obs('shooter'), 500, 9))
  })
})

describe('Marlow', () => {
  test('as keeper dives to the last kick zone about 75% of the time', () => {
    for (const z of [0, 1, 2] as const) {
      const hist = [view(false, 1, 0), view(true, 0, 0), view(false, z, 2)]
      const c = draws('medium', obs('keeper', hist), 4000)
      const share = c[z] / 4000
      // 0.75 on the last kick plus its share of the equilibrium 0.25.
      expect(share).toBeGreaterThan(0.74)
      expect(share).toBeLessThan(0.87)
    }
  })

  test('as shooter goes away from the side the keeper dived to most', () => {
    const hist = [view(true, 1, 0), view(false, 0, 1), view(true, 1, 0)]
    const c = draws('medium', obs('shooter', hist), 3000)
    expect(c[2] / 3000).toBeGreaterThan(0.74)
  })
})

describe('Vesper', () => {
  test('as shooter swaps sides each kick', () => {
    const c = draws('hard', obs('shooter', [view(true, 0, 1), view(false, 1, 1)]), 3000)
    expect(c[2] / 3000).toBeGreaterThan(0.74)
    const d = draws('hard', obs('shooter', [view(true, 2, 1), view(false, 1, 1)]), 3000)
    expect(d[0] / 3000).toBeGreaterThan(0.74)
  })

  test('as keeper expects a swap when the last two kicks differ', () => {
    const c = draws('hard', obs('keeper', [view(false, 0, 1), view(true, 1, 1), view(false, 2, 1)]), 3000)
    expect(c[0] / 3000).toBeGreaterThan(0.74)
  })
})

describe('Sable', () => {
  const sim = {
    // The sim's Sable with no history (plan/bench/more-games-sim/pen.ts, weight 1.5): 0.75 best response to its prior plus 0.25 equilibrium.
    kick: [0.0789, 0.0923, 0.8288],
    dive: [0.106, 0.0384, 0.8555],
  }

  test('with no history keeps at least 3% on every zone and matches the sim mix within 0.02 over 5,000 draws', () => {
    for (const [role, want] of [
      ['shooter', sim.kick],
      ['keeper', sim.dive],
    ] as const) {
      const c = draws('champion', obs(role), 5000)
      const f = c.map((x) => x / 5000)
      for (const p of f) expect(p).toBeGreaterThanOrEqual(0.03)
      // Left and right are a near tie in the best response to the prior (a 0.0003 gap), and the sim built its habit shapes from an
      // earlier table's equilibrium, so its tie fell to the right. Here the shapes use the real equilibrium and the tie can fall either
      // way; the mix must match the sim's or its mirror image.
      const err = (w: readonly number[]) => Math.max(...f.map((p, z) => Math.abs(p - w[z]!)))
      const mirrored = [want[2]!, want[1]!, want[0]!]
      expect(Math.min(err(want), err(mirrored))).toBeLessThan(0.02)
    }
  })

  test('after five kicks to one side its keeper goes to that side over 80%', () => {
    for (const side of [0, 2] as const) {
      const hist: KickView[] = []
      for (let i = 0; i < 5; i++) {
        hist.push(view(false, side, 1))
        hist.push(view(true, 1, 0))
      }
      const c = draws('champion', obs('keeper', hist.slice(0, 9)), 3000)
      expect(c[side] / 3000).toBeGreaterThan(0.8)
    }
  })

  test('reads habits only inside the match it is given: an empty history is the same whatever came before', () => {
    const rngA = makeRng(21)
    const first = Array.from({ length: 30 }, () => choosePenaltyAction('champion', obs('keeper'), rngA, 3))
    // A long run of one-sided kicks in between must leave nothing behind.
    const busy: KickView[] = Array.from({ length: 10 }, () => view(false, 0, 1))
    for (let i = 0; i < 20; i++) choosePenaltyAction('champion', obs('keeper', busy), makeRng(i), 3)
    const rngB = makeRng(21)
    const again = Array.from({ length: 30 }, () => choosePenaltyAction('champion', obs('keeper'), rngB, 3))
    expect(again).toEqual(first)
  })

  test('slowest choice over a full-length history is under 2 ms', () => {
    // Longest possible shootout: 2 * (5 + 12) = 34 kicks, so up to 33 are visible when the last is chosen.
    const hist: KickView[] = []
    for (let i = 0; i < 33; i++) hist.push(view(i % 2 === 0, (i % 3) as Zone, ((i + 1) % 3) as Zone))
    const rng = makeRng(2)
    let worst = 0
    for (const role of ['shooter', 'keeper'] as const) {
      const o = obs(role, hist)
      choosePenaltyAction('champion', o, rng, 0)
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now()
        choosePenaltyAction('champion', o, rng, 0)
        worst = Math.max(worst, performance.now() - t0)
      }
    }
    expect(worst).toBeLessThan(2)
  })
})

describe('createGameAgent', () => {
  test('plays a whole shootout against itself through the core with legal codes, not a preview', async () => {
    for (const level of LEVELS) {
      const a = await createGameAgent(level, { seat: 0 })
      const b = await createGameAgent(level, { seat: 1 })
      expect(a.preview).toBe(false)
      a.reset(77)
      b.reset(77)
      let s = penaltyCore.init(77)
      for (let i = 0; i < 60 && !penaltyCore.terminal(s); i++) {
        const [x] = await a.act(penaltyCore.observe(s, 0))
        const [y] = await b.act(penaltyCore.observe(s, 1))
        s = penaltyCore.step(s, [penaltyCore.decodeAction(x!), penaltyCore.decodeAction(y!)])
      }
      expect(penaltyCore.terminal(s)).toBe(true)
    }
  })

  test('reset gives the same game for the same seed, and seats do not mirror each other', async () => {
    const play = async (seed: number) => {
      const a = await createGameAgent('easy', { seat: 0 })
      const b = await createGameAgent('easy', { seat: 1 })
      a.reset(seed)
      b.reset(seed)
      const out: number[] = []
      const o = penaltyCore.observe(penaltyCore.init(seed), 0)
      for (let i = 0; i < 60; i++) out.push((await a.act(o))[0]!, (await b.act(penaltyCore.observe(penaltyCore.init(seed), 1)))[0]!)
      return out
    }
    expect(await play(5)).toEqual(await play(5))
    const x = await play(5)
    expect(x.filter((_, i) => i % 2 === 0)).not.toEqual(x.filter((_, i) => i % 2 === 1))
  })
})
