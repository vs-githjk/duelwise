import { describe, expect, test } from 'bun:test'
import { GOAL_PER_MILLE, penaltyCore, type KickView, type PenaltyObs, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { choosePenaltyAction, createGameAgent } from './agent'
import { bestKeeper, bestShooter, DIVE_HABITS, KICK_HABITS, predict, streamsOf } from './habits'
import { EQ_KEEPER, EQ_SHOOTER } from './levels'

function one3(i: number): [number, number, number] {
  const d: [number, number, number] = [0, 0, 0]
  d[i] = 1
  return d
}

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

  test('Sable uses the salt only to break a left/right tie; Pip uses it for a favourite side', () => {
    // A clear read leaves nothing to break: the salt changes nothing.
    const clear: KickView[] = []
    for (let i = 0; i < 4; i++) clear.push(view(false, 0, 1), view(true, 1, 0))
    clear.push(view(false, 0, 1))
    const o = obs('keeper', clear)
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

/** Side a no-history opener picks, per salt, from many draws (0 or 2). */
function openerSides(level: Level, role: 'shooter' | 'keeper', kicks: KickView[] = []): Set<number> {
  const sides = new Set<number>()
  for (let salt = 0; salt < 40; salt++) {
    const c = draws(level, obs(role, kicks), 300, salt)
    sides.add(c[0] > c[2] ? 0 : 2)
  }
  return sides
}

/** Shares of a draw count. */
function shares(c: [number, number, number]): number[] {
  const n = c[0] + c[1] + c[2]
  return c.map((x) => x / n)
}

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

  test('as keeper with no kick to read plays the equilibrium dive mix', () => {
    const f = shares(draws('medium', obs('keeper'), 8000))
    for (let i = 0; i < 3; i++) expect(Math.abs(f[i]! - EQ_KEEPER[i]!)).toBeLessThan(0.03)
  })

  test('as shooter goes away from the side the keeper dived to most', () => {
    const hist = [view(true, 1, 0), view(false, 0, 1), view(true, 1, 0)]
    const c = draws('medium', obs('shooter', hist), 3000)
    expect(c[2] / 3000).toBeGreaterThan(0.74)
  })

  test('as shooter opens on the salt side, and keeps it when the keeper dived left and right equally', () => {
    expect(openerSides('medium', 'shooter')).toEqual(new Set([0, 2]))
    const tied = [view(true, 1, 0), view(true, 1, 2)]
    expect(openerSides('medium', 'shooter', tied)).toEqual(new Set([0, 2]))
    const c = shares(draws('medium', obs('shooter', tied), 3000))
    // 0.75 on the salt side plus its share of the equilibrium 0.25.
    expect(Math.max(c[0]!, c[2]!)).toBeGreaterThan(0.8)
    expect(Math.max(c[0]!, c[2]!)).toBeLessThan(0.86)
  })
})

describe('Vesper', () => {
  test('as shooter swaps sides each kick', () => {
    const c = draws('hard', obs('shooter', [view(true, 0, 1), view(false, 1, 1)]), 3000)
    expect(c[2] / 3000).toBeGreaterThan(0.74)
    const d = draws('hard', obs('shooter', [view(true, 2, 1), view(false, 1, 1)]), 3000)
    expect(d[0] / 3000).toBeGreaterThan(0.74)
  })

  test('as shooter opens on the salt side, and after a middle kick picks a salt side again', () => {
    expect(openerSides('hard', 'shooter')).toEqual(new Set([0, 2]))
    expect(openerSides('hard', 'shooter', [view(true, 1, 0)])).toEqual(new Set([0, 2]))
    const c = shares(draws('hard', obs('shooter', [view(true, 1, 0)]), 3000))
    expect(Math.max(c[0]!, c[2]!)).toBeGreaterThan(0.8)
    expect(Math.max(c[0]!, c[2]!)).toBeLessThan(0.86)
  })

  test('as keeper with no kick to read plays the equilibrium dive mix', () => {
    const f = shares(draws('hard', obs('keeper'), 8000))
    for (let i = 0; i < 3; i++) expect(Math.abs(f[i]! - EQ_KEEPER[i]!)).toBeLessThan(0.03)
  })

  test('as keeper expects a swap when the last two kicks differ: read 0.75 plus its equilibrium share', () => {
    // Zones 2 then 0: the swap predicts 2, the most common of the two would say 0.
    const c = draws('hard', obs('keeper', [view(false, 2, 1), view(true, 1, 1), view(false, 0, 1)]), 8000)
    const want = 0.75 + 0.25 * EQ_KEEPER[2]!
    expect(Math.abs(c[2] / 8000 - want)).toBeLessThan(0.02)
    expect(c[0] / 8000).toBeLessThan(0.2)
  })

  test('as keeper takes the most common of the last three when the last two kicks match', () => {
    // 2, 2, 2, 1, 0, 0: the last three are 1, 0, 0, so 0; all six would say 2.
    const zones: Zone[] = [2, 2, 2, 1, 0, 0]
    const hist = zones.map((z) => view(false, z, 1))
    const c = draws('hard', obs('keeper', hist), 8000)
    const want = 0.75 + 0.25 * EQ_KEEPER[0]!
    expect(Math.abs(c[0] / 8000 - want)).toBeLessThan(0.02)
    expect(c[2] / 8000).toBeLessThan(0.2)
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
      // Left and right are a near tie in the best response to the prior (gaps of 0.0014 as shooter, 0.0007 as keeper) and the salt
      // picks the side, so the mix matches the sim's, whose own tie fell to the right, or its mirror image.
      const err = (w: readonly number[]) => Math.max(...f.map((p, z) => Math.abs(p - w[z]!)))
      const mirrored = [want[2]!, want[1]!, want[0]!]
      expect(Math.min(err(want), err(mirrored))).toBeLessThan(0.02)
    }
  })

  test('after five kicks to one side its keeper goes to that side over 97%', () => {
    for (const side of [0, 1, 2] as const) {
      const hist: KickView[] = []
      for (let i = 0; i < 5; i++) {
        hist.push(view(false, side, 1))
        hist.push(view(true, 1, 0))
      }
      const c = draws('champion', obs('keeper', hist.slice(0, 9)), 3000)
      expect(c[side] / 3000).toBeGreaterThan(0.97)
    }
  })

  test('after five dives to one side its shooter goes to the other side over 95%', () => {
    for (const side of [0, 2] as const) {
      const hist: KickView[] = []
      for (let i = 0; i < 5; i++) hist.push(view(true, 1, side), view(false, 1, 1))
      const c = draws('champion', obs('shooter', hist.slice(0, 9)), 3000)
      expect(c[2 - side] / 3000).toBeGreaterThan(0.95)
    }
  })

  test('a keeper facing L R L R L dives right over 97%', () => {
    const zones: Zone[] = [0, 2, 0, 2, 0]
    const hist = zones.flatMap((z): KickView[] => [view(false, z, 1), view(true, 1, 1)]).slice(0, 9)
    const c = draws('champion', obs('keeper', hist), 3000)
    expect(c[2] / 3000).toBeGreaterThan(0.97)
  })

  test('with no history it opens on the salt side, and both sides turn up across salts', () => {
    for (const role of ['shooter', 'keeper'] as const) {
      expect(openerSides('champion', role)).toEqual(new Set([0, 2]))
      for (const salt of [1, 2, 3]) {
        const c = shares(draws('champion', obs(role), 4000, salt))
        // 0.75 (after the weight) best response to the prior plus the equilibrium share: well above half, never all.
        expect(Math.max(c[0]!, c[2]!)).toBeGreaterThan(0.75)
      }
    }
  })

  test('the side tie rule never overrides a Middle best response', () => {
    const s = streamsOf([0, 1, 2].map((d, i) => view(true, [0, 0, 1][i] as Zone, d as Zone)))
    expect(s.oppDives).toEqual([0, 1, 2])
    expect(s.myKicks).toEqual([0, 0, 1])
    const out = predict(DIVE_HABITS, s.oppDives, s.myKicks).out
    expect(bestShooter(out)).toEqual(one3(1))
    expect(bestShooter(out, 2)).toEqual(one3(1))
  })

  test('the shoot and dive favourites are independent: all four pairs turn up across salts', () => {
    const major = (role: 'shooter' | 'keeper', salt: number) => {
      const c = draws('easy', obs(role), 60, salt)
      return c[0] > c[2] ? 0 : 2
    }
    const pairs = new Set<string>()
    for (let salt = 1; salt <= 40; salt++) pairs.add(`${major('shooter', salt)}${major('keeper', salt)}`)
    expect(pairs).toEqual(new Set(['00', '02', '20', '22']))
  })

  // Through the agent: the "copies my last" and "avoids my last" streams must reach predict().
  test('champion keeper reads a player who copies its last dive', () => {
    const opp = [0, 2, 2, 2, 2, 2]
    const mine = [2, 2, 2, 2, 2, 0]
    const hist = opp.map((z, i) => view(false, z as Zone, mine[i] as Zone))
    const c = draws('champion', obs('keeper', hist), 2000)
    expect(c.indexOf(Math.max(...c))).toBe(0)
  })

  test('champion shooter reads a keeper that copies its last kick', () => {
    const mine = [1, 1, 1, 1, 1, 0]
    const hist = mine.map((z, i) => view(true, z as Zone, 1))
    const c = draws('champion', obs('shooter', hist), 2000)
    expect(c.indexOf(Math.max(...c))).toBe(2)
  })

  // One habit shape at a time: with that shape swapped for plain equilibrium play the answer would be a different zone.
  // [name, opponent's stream, what I did alongside it, the zone that must come out].
  const keeperShapes: [string, number[], number[], number][] = [
    ['favourite left', [2, 0, 0, 2, 0], [0, 0, 0, 0, 0], 0],
    ['favourite middle', [1, 1, 1, 1, 1, 2], [0, 0, 0, 0, 0, 0], 1],
    ['favourite right', [2, 2, 2, 2, 2, 1], [0, 0, 0, 0, 0, 0], 2],
    ['repeat', [2, 2, 2, 2, 1, 1], [0, 0, 0, 0, 0, 0], 1],
    ['alternate', [1, 2, 1, 2, 1, 2], [0, 0, 0, 0, 0, 0], 1],
    ['mirror', [0, 2, 0, 2, 0, 0], [0, 0, 0, 0, 0, 0], 2],
    ['copies my last', [0, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 0], 0],
    ['avoids my last', [0, 2, 0, 2, 2], [0, 1, 0, 0, 0], 2],
  ]
  for (const [name, opp, mine, zone] of keeperShapes) {
    test(`keeper reads the "${name}" habit`, () => {
      const hist = opp.flatMap((z, i): KickView[] => [view(false, z as Zone, mine[i] as Zone)])
      const s = streamsOf(hist)
      expect(s.oppKicks).toEqual(opp)
      expect(bestKeeper(predict(KICK_HABITS, s.oppKicks, s.myDives).out)).toEqual(one3(zone))
    })
  }

  const shooterShapes: [string, number[], number[], number][] = [
    ['favourite left', [0, 0, 0, 1, 1, 1], [0, 0, 0, 0, 0, 0], 2],
    ['favourite middle', [1, 1, 1, 1, 1, 0], [0, 0, 0, 0, 0, 0], 0],
    ['favourite right', [2, 2, 2, 2, 2, 0], [0, 0, 0, 0, 0, 0], 0],
    ['repeat', [1, 1, 1, 1, 1, 2], [0, 0, 0, 0, 0, 0], 0],
    ['alternate', [1, 1, 1, 1, 0, 1], [0, 0, 0, 0, 0, 0], 2],
    ['mirror', [1, 1, 1, 1, 1, 0], [0, 0, 0, 0, 0, 0], 0],
    ['copies my last', [1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 0], 2],
    ['avoids my last', [1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 2], 2],
  ]
  for (const [name, opp, mine, zone] of shooterShapes) {
    test(`shooter reads the "${name}" habit`, () => {
      const hist = opp.map((d, i) => view(true, mine[i] as Zone, d as Zone))
      const s = streamsOf(hist)
      expect(s.oppDives).toEqual(opp)
      expect(bestShooter(predict(DIVE_HABITS, s.oppDives, s.myKicks).out)).toEqual(one3(zone))
    })
  }

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
    // A real slow path is slow in every sweep; a scheduler or GC pause hits one. So the smallest sweep's worst is what counts.
    const sweeps: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
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
      sweeps.push(worst)
      if (worst < 2) break
    }
    const best = Math.min(...sweeps)
    console.log(`slowest choice, smallest sweep worst: ${best.toFixed(3)} ms (sweeps: ${sweeps.map((x) => x.toFixed(3)).join(', ')})`)
    expect(best).toBeLessThan(2)
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

  test('reset gives the same game for the same seed', async () => {
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
  })

  test('seats mix into both the rng and the salt; seeds change the favourite', async () => {
    const o = obs('shooter')
    const stream = async (seat: 0 | 1, seed: number, n: number) => {
      const a = await createGameAgent('easy', { seat })
      a.reset(seed)
      const out: number[] = []
      for (let i = 0; i < n; i++) out.push((await a.act(o))[0]!)
      return out
    }
    const side = (xs: number[]) => (xs.filter((x) => x === 0).length > xs.filter((x) => x === 2).length ? 0 : 2)
    // Same seed, role and observation: the seat alone must change the action stream.
    expect(await stream(0, 5, 60)).not.toEqual(await stream(1, 5, 60))
    const favs: [number[], number[]] = [[], []]
    for (let seed = 1; seed <= 24; seed++) {
      favs[0].push(side(await stream(0, seed, 300)))
      favs[1].push(side(await stream(1, seed, 300)))
    }
    // The favourite differs between the seats for some seed, and between seeds for one seat.
    expect(favs[0].some((f, i) => f !== favs[1][i])).toBe(true)
    expect(new Set(favs[0]).size).toBe(2)
    expect(new Set(favs[1]).size).toBe(2)
  })
})
