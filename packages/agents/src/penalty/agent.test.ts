import { describe, expect, test } from 'bun:test'
import { GOAL_PER_MILLE, penaltyCore, type Dive, type KickView, type PenaltyObs, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import { choosePenaltyAction, createGameAgent } from './agent'
import { bestKeeper, bestShooter, COVER, DIVE_HABITS, floored, KICK_HABITS, mirrorDive, mirrorZone, one, predict, streamsOf } from './habits'
import { EQ_KEEPER, EQ_SHOOTER } from './levels'

const zoneAt = (z: number) => one(z, 9)
const diveAt = (d: number) => one(d, 5)
const TL = 0, TM = 1, TR = 2, ML = 3, C = 4, MR = 5, BL = 6, BM = 7, BR = 8
const LH = 0, LL = 1, STAY = 2, RH = 3, RL = 4

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

function view(byMe: boolean, zone: number, dive: number): KickView {
  return { byMe, zone: zone as Zone, dive: dive as Dive, outcome: 'wide' }
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

/** Draw `n` actions from one seeded rng, same obs and salt each time. Counts per action, nine or five entries by role. */
function draws(level: Level, o: PenaltyObs, n: number, salt = 7, seed = 11): number[] {
  const rng = makeRng(seed)
  const c: number[] = new Array<number>(o.role === 'shooter' ? 9 : 5).fill(0)
  for (let i = 0; i < n; i++) c[choosePenaltyAction(level, o, rng, salt)]!++
  return c
}

/** The exact mix behind one choice, read through the real function: `pick` walks the running total, so a stub rng can bisect for each step of it. */
function exactMix(level: Level, o: PenaltyObs, salt = 7): number[] {
  const at = (r: number) => choosePenaltyAction(level, o, { float: () => r } as unknown as Rng, salt)
  const n = o.role === 'shooter' ? 9 : 5
  const out: number[] = new Array<number>(n).fill(0)
  let from = 0
  for (let i = 0; i < n - 1; i++) {
    let lo = from
    let hi = 1
    for (let step = 0; step < 60; step++) {
      const mid = (lo + hi) / 2
      if (at(mid) <= i) lo = mid
      else hi = mid
    }
    out[i] = hi - from
    from = hi
  }
  out[n - 1] = 1 - from
  return out
}

/** Fictitious play on the goal table, the same way the sim checks its equilibrium. */
function fictitiousPlay(): { s: number[]; k: number[] } {
  const M = GOAL_PER_MILLE.map((r) => r.map((x) => x / 1000))
  const sc: number[] = new Array<number>(9).fill(0)
  const kc: number[] = new Array<number>(5).fill(0)
  const sv: number[] = new Array<number>(9).fill(0)
  const kv: number[] = new Array<number>(5).fill(0)
  let s = 4
  let k = 2
  for (let t = 0; t < 1_000_000; t++) {
    sc[s]!++
    kc[k]!++
    for (let i = 0; i < 9; i++) sv[i]! += M[i]![k]!
    for (let j = 0; j < 5; j++) kv[j]! += M[s]![j]!
    s = sv.indexOf(Math.max(...sv))
    k = kv.indexOf(Math.min(...kv))
  }
  const norm = (a: number[]) => a.map((x) => x / a.reduce((p, q) => p + q, 0))
  return { s: norm(sc), k: norm(kc) }
}

const M1 = GOAL_PER_MILLE.map((r) => r.map((x) => x / 1000))
const kickValue = (sd: readonly number[], kd: readonly number[]) => sd.reduce((a, p, z) => a + p * kd.reduce((b, q, d) => b + q * M1[z]![d]!, 0), 0)

describe('equilibrium constants', () => {
  test('match fictitious play on the goal table within 0.01', () => {
    const { s, k } = fictitiousPlay()
    for (let i = 0; i < 9; i++) expect(Math.abs(EQ_SHOOTER[i]! - s[i]!)).toBeLessThan(0.01)
    for (let i = 0; i < 5; i++) expect(Math.abs(EQ_KEEPER[i]! - k[i]!)).toBeLessThan(0.01)
    expect(EQ_SHOOTER.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
    expect(EQ_KEEPER.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
  })

  test('the skill is real: random play is well below perfect play on both sides, and the centre is a bluff both sides must respect', () => {
    const v = kickValue(EQ_SHOOTER, EQ_KEEPER)
    const uz = new Array<number>(9).fill(1 / 9)
    const ud = new Array<number>(5).fill(1 / 5)
    // Random kicks into the equilibrium keeper lose at least 5 points a kick, and at least 10 once the keeper answers them.
    expect(v - kickValue(uz, EQ_KEEPER)).toBeGreaterThan(0.05)
    expect(v - Math.min(...[0, 1, 2, 3, 4].map((d) => kickValue(uz, diveAt(d))))).toBeGreaterThan(0.1)
    // A random keeper gives up at least 5 points a kick to a shooter who answers it.
    expect(Math.max(...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((z) => kickValue(zoneAt(z), ud))) - v).toBeGreaterThan(0.045)
    // Straight down the middle is in the mix, and so is staying: neither side can drop it.
    expect(EQ_SHOOTER[C]!).toBeGreaterThan(0.1)
    expect(EQ_KEEPER[STAY]!).toBeGreaterThan(0.1)
    // Top corners are shot more than bottom ones at equilibrium: worth the miss.
    expect(EQ_SHOOTER[TL]!).toBeGreaterThan(EQ_SHOOTER[BL]!)
  })
})

describe('every level', () => {
  const histories: KickView[][] = [
    [],
    [view(true, TR, LH)],
    [view(false, BR, STAY), view(true, C, LL), view(false, TL, RH)],
    [view(true, MR, RL), view(false, TM, LH), view(true, BM, STAY), view(false, ML, RH), view(true, BL, LH)],
  ]
  for (const level of LEVELS) {
    for (const [role, n] of [['shooter', 9], ['keeper', 5]] as const) {
      test(`${level} returns a legal code for the ${role}, 0..${n - 1}`, () => {
        const rng = makeRng(5)
        for (const h of histories) {
          for (let i = 0; i < 50; i++) {
            const a = choosePenaltyAction(level, obs(role, h), rng, i)
            expect(Number.isInteger(a) && a >= 0 && a < n).toBe(true)
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
    const hist = [view(false, TL, RH), view(true, TR, LH), view(false, TL, LL), view(true, C, STAY)]
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

  test('Sable uses the salt only to break a left/right tie; Pip uses it for a favourite', () => {
    // A clear read leaves nothing to break: the salt changes nothing.
    const clear: KickView[] = []
    for (let i = 0; i < 4; i++) clear.push(view(false, TL, LL), view(true, C, LH))
    clear.push(view(false, TL, LL))
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
    const pipCorners = new Set<number>()
    for (let salt = 0; salt < 60; salt++) {
      const c = draws('easy', obs('shooter'), 200, salt)
      pipCorners.add(c.indexOf(Math.max(...c)))
    }
    expect(pipCorners).toEqual(new Set([TL, TR, BL, BR]))
  })
})

describe('Pip', () => {
  test('a favourite and its mirror lead, and every zone and dive still gets a share, in both roles', () => {
    for (const role of ['shooter', 'keeper'] as const) {
      for (const salt of [1, 2, 3, 4, 5, 6]) {
        const m = exactMix('easy', obs(role), salt)
        // The keeper's biggest share is the stay; its favourite is the biggest side dive.
        const f = m.indexOf(Math.max(...m.map((x, i) => (role === 'keeper' && i === STAY ? 0 : x))))
        const mir = role === 'shooter' ? mirrorZone(f) : mirrorDive(f)
        expect(m.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
        expect(m[f]!).toBeGreaterThan(m[mir]!)
        expect(m.every((x, i) => i === f || i === mir || (role === 'keeper' && i === STAY) || x < m[mir]!)).toBe(true)
        expect(Math.min(...m)).toBeGreaterThanOrEqual(0.007)
        if (role === 'shooter') {
          expect([TL, TR, BL, BR]).toContain(f)
          expect(m[C]!).toBeGreaterThanOrEqual(0.05)
          for (const z of [TL, TR, BL, BR]) expect(m[z]!).toBeGreaterThanOrEqual(0.03)
        } else {
          expect(m[STAY]!).toBeCloseTo(0.4, 6)
          for (const d of [LH, LL, RH, RL]) expect(m[d]!).toBeGreaterThanOrEqual(0.05)
        }
      }
    }
  })

  test('over 1000 kicks one match shows at least seven different zones and all five dives', () => {
    expect(draws('easy', obs('shooter'), 1000, 7).filter((x) => x > 0).length).toBeGreaterThanOrEqual(7)
    expect(draws('easy', obs('keeper'), 1000, 7).filter((x) => x > 0).length).toBe(5)
  })

  test('is not moved by what happened', () => {
    const hist = [view(false, TL, LH), view(true, TL, LH), view(false, TL, LH)]
    expect(draws('easy', obs('shooter', hist), 500, 9)).toEqual(draws('easy', obs('shooter'), 500, 9))
  })
})

/** Left or right of the goal for a kick count: 0 or 2. */
const kickSide = (c: number[]) => (c[TL]! + c[ML]! + c[BL]! > c[TR]! + c[MR]! + c[BR]! ? 0 : 2)

/** Side a no-history opener picks, per salt, from many draws (0 or 2). */
function openerSides(level: Level, kicks: KickView[] = []): Set<number> {
  const sides = new Set<number>()
  for (let salt = 0; salt < 40; salt++) sides.add(kickSide(draws(level, obs('shooter', kicks), 300, salt)))
  return sides
}

/** Shares of a draw count. */
function shares(c: number[]): number[] {
  const n = c.reduce((a, b) => a + b, 0)
  return c.map((x) => x / n)
}

describe('Marlow', () => {
  test('as keeper answers the last kick about 75% of the time, whichever zone it was', () => {
    for (let z = 0; z < 9; z++) {
      const hist = [view(false, C, LH), view(true, TL, LH), view(false, z, STAY)]
      const c = draws('medium', obs('keeper', hist), 4000)
      const share = c[COVER[z]!]! / 4000
      // 0.75 on the cover plus its share of the equilibrium 0.25.
      expect(share).toBeGreaterThan(0.74)
      expect(share).toBeLessThan(0.87)
    }
  })

  test('as keeper with no kick to read plays the equilibrium dive mix', () => {
    const f = shares(draws('medium', obs('keeper'), 8000))
    for (let i = 0; i < 5; i++) expect(Math.abs(f[i]! - EQ_KEEPER[i]!)).toBeLessThan(0.03)
  })

  test('as shooter goes away from the side the keeper dived to most', () => {
    const hist = [view(true, C, LH), view(false, TL, LL), view(true, C, LL)]
    const c = draws('medium', obs('shooter', hist), 3000)
    expect((c[TR]! + c[BR]!) / 3000).toBeGreaterThan(0.64)
    const d = draws('medium', obs('shooter', [view(true, C, RH), view(true, C, RL)]), 3000)
    expect((d[TL]! + d[BL]!) / 3000).toBeGreaterThan(0.64)
  })

  test('as shooter keeps the height of its favourite corner when it goes away, in both rows', () => {
    const rows = new Set<number>()
    const away = [view(true, C, LH), view(true, C, LL)]
    for (let salt = 0; salt < 40; salt++) {
      const open = draws('medium', obs('shooter'), 300, salt)
      const row = Math.floor(open.indexOf(Math.max(...open)) / 3)
      rows.add(row)
      const c = draws('medium', obs('shooter', away), 300, salt)
      expect(c.indexOf(Math.max(...c))).toBe(row * 3 + 2)
    }
    expect(rows).toEqual(new Set([0, 2]))
  })

  test('as shooter opens on the salt corner, and keeps it when the keeper dived left and right equally', () => {
    expect(openerSides('medium')).toEqual(new Set([0, 2]))
    const tied = [view(true, C, LH), view(true, C, RL)]
    expect(openerSides('medium', tied)).toEqual(new Set([0, 2]))
    // 0.45 on the salt corner plus that corner's own share of the equilibrium 0.55, for each of the four corners.
    const corners = new Set<number>()
    for (let salt = 0; salt < 40; salt++) {
      const m = exactMix('medium', obs('shooter', tied), salt)
      const corner = m.indexOf(Math.max(...m))
      corners.add(corner)
      expect(m[corner]!).toBeCloseTo(0.45 + 0.55 * EQ_SHOOTER[corner]!, 6)
    }
    expect(corners).toEqual(new Set([TL, TR, BL, BR]))
  })
})

describe('Vesper', () => {
  test('as shooter swaps corners each kick', () => {
    for (const z of [TL, TR, BL, BR]) {
      const c = draws('hard', obs('shooter', [view(true, z, STAY), view(false, C, STAY)]), 3000)
      expect(c[mirrorZone(z)]! / 3000).toBeGreaterThan(0.74)
    }
  })

  test('as shooter opens on the salt corner, and after a middle kick picks a salt corner again', () => {
    expect(openerSides('hard')).toEqual(new Set([0, 2]))
    expect(openerSides('hard', [view(true, C, LH)])).toEqual(new Set([0, 2]))
    const corners = new Set<number>()
    for (let salt = 0; salt < 40; salt++) {
      const m = exactMix('hard', obs('shooter', [view(true, C, LH)]), salt)
      const corner = m.indexOf(Math.max(...m))
      corners.add(corner)
      expect(m[corner]!).toBeCloseTo(0.75 + 0.25 * EQ_SHOOTER[corner]!, 6)
    }
    expect(corners).toEqual(new Set([TL, TR, BL, BR]))
  })

  test('as keeper with no kick to read plays the equilibrium dive mix', () => {
    const f = shares(draws('hard', obs('keeper'), 8000))
    for (let i = 0; i < 5; i++) expect(Math.abs(f[i]! - EQ_KEEPER[i]!)).toBeLessThan(0.03)
  })

  test('as keeper expects a swap when the last two kicks differ: read 0.75 plus its equilibrium share', () => {
    // Zones BR then TL: the swap predicts BR, the most common of the two would say TL or BR's cover by count.
    const c = draws('hard', obs('keeper', [view(false, BR, STAY), view(true, C, STAY), view(false, TL, STAY)]), 8000)
    const want = 0.75 + 0.25 * EQ_KEEPER[RL]!
    expect(Math.abs(c[RL]! / 8000 - want)).toBeLessThan(0.02)
    expect(c[LH]! / 8000).toBeLessThan(0.2)
  })

  test('as keeper takes the most common of the last three when the last two kicks match', () => {
    // BR, BR, BR, C, TL, TL: the last three are C, TL, TL, so TL; all six would say BR.
    const hist = [BR, BR, BR, C, TL, TL].map((z) => view(false, z, STAY))
    const c = draws('hard', obs('keeper', hist), 8000)
    const want = 0.75 + 0.25 * EQ_KEEPER[LH]!
    expect(Math.abs(c[LH]! / 8000 - want)).toBeLessThan(0.02)
    expect(c[RL]! / 8000).toBeLessThan(0.2)
  })
})

describe('Sable', () => {
  // Written out, not through floored(): the four zones the equilibrium skips hold exactly 3%, the other five share the 0.88 left in their equilibrium proportions.
  const OPEN_SHOOTER = [0.2525, 0.03, 0.2525, 0.03, 0.1736, 0.03, 0.1607, 0.03, 0.1607].map((p) => (p === 0.03 ? p : p * 0.88))
  // Every dive is in the equilibrium already, so the floor touches none; the constants sum to 1.0001, and the mix is rescaled to 1.
  const OPEN_KEEPER = [0.1716, 0.2671, 0.1227, 0.1716, 0.2671].map((p) => p / 1.0001)

  test('with no history its opening mix is exact, and no zone or dive holds under a true 3%', () => {
    for (const [role, want] of [
      ['shooter', OPEN_SHOOTER],
      ['keeper', OPEN_KEEPER],
    ] as const) {
      const m = exactMix('champion', obs(role))
      expect(m.length).toBe(want.length)
      for (let i = 0; i < m.length; i++) {
        expect(m[i]!).toBeCloseTo(want[i]!, 6)
        expect(m[i]!).toBeGreaterThan(0.03 - 1e-9)
      }
    }
    expect(OPEN_SHOOTER.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    expect(OPEN_KEEPER.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })

  test('with no history the draws follow that mix over 5,000 draws', () => {
    for (const [role, want] of [
      ['shooter', OPEN_SHOOTER],
      ['keeper', OPEN_KEEPER],
    ] as const) {
      const f = shares(draws('champion', obs(role), 5000))
      for (let i = 0; i < f.length; i++) {
        expect(f[i]!).toBeGreaterThanOrEqual(0.03 * 0.75) // 3% of the mix, less sampling noise at 5,000 draws (sd about 0.0025)
        expect(Math.abs(f[i]! - want[i]!)).toBeLessThan(0.02)
      }
    }
  })

  test('the floor holds entries at exactly the minimum, also one that the rescale would push back under it', () => {
    const lifted = floored([0.5, 0.5, 0, 0], 0.03)
    for (const [i, p] of [0.47, 0.47, 0.03, 0.03].entries()) expect(lifted[i]!).toBeCloseTo(p, 12)
    const pushed = floored([0.85, 0.03, 0.12, 0], 0.03)
    for (const [i, p] of [(0.85 * 0.94) / 0.97, 0.03, (0.12 * 0.94) / 0.97, 0.03].entries()) expect(pushed[i]!).toBeCloseTo(p, 12)
    expect(floored([0.6, 0.4], 0.03)).toEqual([0.6, 0.4])
  })

  test('after five kicks to one zone its keeper answers that zone over 97%', () => {
    for (const z of [TL, TR, C, BL, BR]) {
      const hist: KickView[] = []
      for (let i = 0; i < 5; i++) hist.push(view(false, z, STAY), view(true, C, LH))
      const c = draws('champion', obs('keeper', hist.slice(0, 9)), 3000)
      expect(c[COVER[z]!]! / 3000).toBeGreaterThan(0.97)
    }
  })

  test('after five dives to one side its shooter goes to the other side over 95%', () => {
    for (const [dive, zones] of [
      [LH, [TR, MR, BR, TM, BM]],
      [RL, [TL, ML, BL, TM, BM]],
    ] as const) {
      const hist: KickView[] = []
      for (let i = 0; i < 5; i++) hist.push(view(true, C, dive), view(false, C, STAY))
      const c = draws('champion', obs('shooter', hist.slice(0, 9)), 3000)
      expect(zones.reduce((a: number, z: number) => a + c[z]!, 0) / 3000).toBeGreaterThan(0.95)
    }
  })

  test('a keeper facing TL TR TL TR TL covers top right over 97%', () => {
    const zones = [TL, TR, TL, TR, TL]
    const hist = zones.flatMap((z): KickView[] => [view(false, z, STAY), view(true, C, STAY)]).slice(0, 9)
    const c = draws('champion', obs('keeper', hist), 3000)
    expect(c[RH]! / 3000).toBeGreaterThan(0.97)
  })

  test('with no history no side is favoured, whatever the salt', () => {
    for (const role of ['shooter', 'keeper'] as const) {
      for (const salt of [1, 2, 3]) {
        const c = shares(draws('champion', obs(role), 8000, salt))
        const [left, right] = role === 'shooter' ? [c[TL]! + c[ML]! + c[BL]!, c[TR]! + c[MR]! + c[BR]!] : [c[LH]! + c[LL]!, c[RH]! + c[RL]!]
        expect(Math.abs(left - right)).toBeLessThan(0.04)
      }
    }
  })

  test('a left/right tie goes to the salt side both ways, and the tie rule never overrides a stay or a middle best response', () => {
    const even = new Array<number>(9).fill(0)
    even[TL] = 0.5
    even[TR] = 0.5
    expect(bestKeeper(even, 0)).toEqual(diveAt(LH))
    expect(bestKeeper(even, 2)).toEqual(diveAt(RH))
    const stayAll = [0, 0, 0, 0, 1, 0, 0, 0, 0]
    expect(bestKeeper(stayAll, 0)).toEqual(diveAt(STAY))
    expect(bestKeeper(stayAll, 2)).toEqual(diveAt(STAY))
    const dives = [0.5, 0, 0, 0.5, 0]
    expect(bestShooter(dives, 0)).toEqual(zoneAt(BL))
    expect(bestShooter(dives, 2)).toEqual(zoneAt(BR))
    const allStay = [0, 0, 1, 0, 0]
    expect(bestShooter(allStay, 0)).toEqual(zoneAt(BL))
    expect(bestShooter(allStay, 2)).toEqual(zoneAt(BR))
    // TM against a keeper low on both sides: a middle best response stays put under either side.
    const lows = [0, 0.5, 0, 0, 0.5]
    expect(bestShooter(lows, 0)).toEqual(bestShooter(lows, 2))
  })

  test('the shoot and dive favourites are independent: all sixteen pairs turn up across salts', () => {
    const major = (role: 'shooter' | 'keeper', salt: number) => {
      const c = exactMix('easy', obs(role), salt).map((x, i) => (role === 'keeper' && i === STAY ? 0 : x))
      return c.indexOf(Math.max(...c))
    }
    const pairs = new Set<string>()
    for (let salt = 1; salt <= 300; salt++) pairs.add(`${major('shooter', salt)}.${major('keeper', salt)}`)
    expect(pairs.size).toBe(16)
  })

  // Through the agent: the "copies my last" and "avoids my last" streams must reach predict().
  test('champion keeper reads a player who copies its last dive', () => {
    const opp = [TL, TR, TL, TL, TR, TR]
    const mine = [RH, LH, LH, RH, RH, LH]
    const hist = opp.map((z, i) => view(false, z, mine[i]!))
    const c = draws('champion', obs('keeper', hist), 2000)
    expect(c.indexOf(Math.max(...c))).toBe(LH)
  })

  test('champion shooter reads a keeper that copies its last kick', () => {
    const mine = [BL, BL, BL, BL, BL, BR]
    const opp = [STAY, LL, LL, LL, LL, LL]
    const hist = mine.map((z, i) => view(true, z, opp[i]!))
    const c = draws('champion', obs('shooter', hist), 2000)
    const left = c[TL]! + c[ML]! + c[BL]!
    expect(left).toBeGreaterThan(c[TR]! + c[MR]! + c[BR]!)
    expect(c[BR]! / 2000).toBeLessThan(0.1)
  })

  // One habit shape at a time: with that shape swapped for plain equilibrium play the answer would be a different choice.
  // [name, opponent's stream, what I did alongside it, the choice that must come out].
  const keeperShapes: [string, number[], number[], number][] = [
    ['favourite top left', [TL, TL, TL, TR, TL, TL], [2, 2, 2, 2, 2, 2], LH],
    ['favourite top right', [TR, TR, TR, TL, TR, TR], [2, 2, 2, 2, 2, 2], RH],
    ['favourite bottom left', [BL, BL, BL, BR, BL, BL], [2, 2, 2, 2, 2, 2], LL],
    ['favourite bottom right', [BR, BR, BR, BL, BR, BR], [2, 2, 2, 2, 2, 2], RL],
    ['favourite centre', [C, C, C, BR, C, C], [2, 2, 2, 2, 2, 2], STAY],
    ['repeat', [TR, TR, TR, TR, BR, BR], [2, 2, 2, 2, 2, 2], RL],
    ['alternate', [BL, TR, BL, TR, BL, TR], [2, 2, 2, 2, 2, 2], LL],
    ['mirror', [TL, TR, TL, TR, TL, TL], [2, 2, 2, 2, 2, 2], RH],
    ['copies my last', [TL, TR, TL, TL, TR, TR], [RH, LH, LH, RH, RH, LH], LH],
    ['avoids my last', [TR, BL, BR, TR, BL, BR], [LH, LH, LH, LH, LH, LH], STAY],
  ]
  for (const [name, opp, mine, dive] of keeperShapes) {
    test(`keeper reads the "${name}" habit`, () => {
      const hist = opp.flatMap((z, i): KickView[] => [view(false, z, mine[i]!)])
      const s = streamsOf(hist)
      expect(s.oppKicks).toEqual(opp)
      expect(bestKeeper(predict(KICK_HABITS, s.oppKicks, s.myDives).out)).toEqual(diveAt(dive))
    })
  }

  const shooterShapes: [string, number[], number[], number][] = [
    ['favourite left high', [LH, LH, LH, RH, LH], [C, C, C, C, C], BR],
    ['favourite left low', [LL, LL, LL, RL, LL], [C, C, C, C, C], BR],
    ['favourite stay', [STAY, STAY, STAY, STAY, STAY], [C, C, C, C, C], BL],
    ['favourite right high', [RH, RH, RH, LL, RH], [C, C, C, C, C], BL],
    ['favourite right low', [RL, RL, RL, LH, RL], [C, C, C, C, C], BL],
    ['repeat', [RH, RH, RH, RH, LL, LL], [C, C, C, C, C, C], BR],
    ['alternate', [LL, RL, LL, RL, LL, RL], [C, C, C, C, C, C], BR],
    ['mirror', [LH, RH, LH, RH, LH, LH], [C, C, C, C, C, C], BL],
    ['copies my last', [STAY, RL, RL, RL, RL, RL], [BR, BR, BR, BR, BR, TL], BL],
    ['avoids my last', [LH, RH, LH, RH, LH, RH], [BR, TL, BR, TL, BR, TL], BR],
  ]
  for (const [name, opp, mine, zone] of shooterShapes) {
    test(`shooter reads the "${name}" habit`, () => {
      const hist = opp.map((d, i) => view(true, mine[i]!, d))
      const s = streamsOf(hist)
      expect(s.oppDives).toEqual(opp)
      expect(bestShooter(predict(DIVE_HABITS, s.oppDives, s.myKicks).out)).toEqual(zoneAt(zone))
    })
  }

  test('reads habits only inside the match it is given: an empty history is the same whatever came before', () => {
    const rngA = makeRng(21)
    const first = Array.from({ length: 30 }, () => choosePenaltyAction('champion', obs('keeper'), rngA, 3))
    // A long run of one-sided kicks in between must leave nothing behind.
    const busy: KickView[] = Array.from({ length: 10 }, () => view(false, TL, LL))
    for (let i = 0; i < 20; i++) choosePenaltyAction('champion', obs('keeper', busy), makeRng(i), 3)
    const rngB = makeRng(21)
    const again = Array.from({ length: 30 }, () => choosePenaltyAction('champion', obs('keeper'), rngB, 3))
    expect(again).toEqual(first)
  })

  test('slowest choice over a full-length history is under 2 ms', () => {
    // Longest possible shootout: 2 * (5 + 12) = 34 kicks, so up to 33 are visible when the last is chosen.
    const hist: KickView[] = []
    for (let i = 0; i < 33; i++) hist.push(view(i % 2 === 0, i % 9, (i + 1) % 5))
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
    const side = (xs: number[]) => {
      const c = new Array<number>(9).fill(0)
      for (const x of xs) c[x]!++
      return c.indexOf(Math.max(...c))
    }
    // Same seed, role and observation: the seat alone must change the action stream.
    expect(await stream(0, 5, 60)).not.toEqual(await stream(1, 5, 60))
    const favs: [number[], number[]] = [[], []]
    for (let seed = 1; seed <= 24; seed++) {
      favs[0].push(side(await stream(0, seed, 300)))
      favs[1].push(side(await stream(1, seed, 300)))
    }
    // The favourite differs between the seats for some seed, and between seeds for one seat.
    expect(favs[0].some((f, i) => f !== favs[1][i])).toBe(true)
    expect(new Set(favs[0]).size).toBeGreaterThanOrEqual(2)
    expect(new Set(favs[1]).size).toBeGreaterThanOrEqual(2)
  })
})
