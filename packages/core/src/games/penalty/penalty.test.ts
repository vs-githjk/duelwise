import { describe, expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import { EXTRA_ROUNDS, GOAL_PER_MILLE, KICKS, createPenaltyCore, penaltyCore, type Kick, type PenaltyState, type Zone } from './index'

const core = penaltyCore

/** A state with the given goal flags, kick 0 by seat 0, then alternating. Zones are irrelevant to the end rules. */
function withGoals(flags: boolean[], seed = 1): PenaltyState {
  const kicks: Kick[] = flags.map((goal, i) => ({ kicker: (i % 2) as 0 | 1, zone: 0, dive: 1, goal }))
  return { seed, kicks }
}

/** n kicks, seat 0 goals as given, seat 1 goals as given (flags per seat, in order). */
function fromSeats(a: boolean[], b: boolean[]): PenaltyState {
  const flags: boolean[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) flags.push(a[i])
    if (i < b.length) flags.push(b[i])
  }
  return withGoals(flags)
}

const T = true
const F = false

function play(s: PenaltyState, a: Zone, b: Zone): PenaltyState {
  return core.step(s, [a, b])
}

describe('penalty core: ticks and actions', () => {
  test('toAct is [0, 1] on every tick until the end, then []', () => {
    let s = core.init(7)
    const rng = makeRng(3)
    let ticks = 0
    while (!core.terminal(s)) {
      expect(core.toAct(s)).toEqual([0, 1])
      expect(core.legal(s, 0)).toEqual([0, 1, 2])
      expect(core.legal(s, 1)).toEqual([0, 1, 2])
      s = play(s, rng.int(3) as Zone, rng.int(3) as Zone)
      ticks++
    }
    expect(ticks).toBeGreaterThanOrEqual(KICKS + 1)
    expect(core.toAct(s)).toEqual([])
    expect(core.legal(s, 0)).toEqual([])
    expect(() => play(s, 0, 0)).toThrow()
  })

  test('step throws on a missing action from either seat and on a bad zone', () => {
    const s = core.init(1)
    expect(() => core.step(s, [0, null])).toThrow()
    expect(() => core.step(s, [null, 1])).toThrow()
    expect(() => core.step(s, [null, null])).toThrow()
    expect(() => core.step(s, [3 as Zone, 0])).toThrow()
    expect(() => core.step(s, [0, -1 as Zone])).toThrow()
    expect(() => core.step(s, [1.5 as Zone, 0])).toThrow()
    expect(() => core.step(s, ['1' as unknown as Zone, 0])).toThrow()
  })

  test('step is pure: the input state is not changed and the same call gives the same result', () => {
    const s = core.init(9)
    const before = JSON.stringify(s)
    const a = core.step(s, [1, 2])
    const b = core.step(s, [1, 2])
    expect(JSON.stringify(s)).toBe(before)
    expect(a).toEqual(b)
    expect(a.kicks.length).toBe(1)
    expect(s.kicks.length).toBe(0)
  })
})

describe('penalty core: roles and kicks', () => {
  test('seat 0 shoots first and the roles swap each kick', () => {
    let s = core.init(2)
    for (let i = 0; i < 6; i++) {
      const shooter = (i % 2) as 0 | 1
      expect(core.observe(s, shooter).role).toBe('shooter')
      expect(core.observe(s, (1 - shooter) as 0 | 1).role).toBe('keeper')
      // The shooter picks zone 2, the keeper picks zone 0.
      s = shooter === 0 ? play(s, 2, 0) : play(s, 0, 2)
      const k = s.kicks[i]
      expect(k.kicker).toBe(shooter)
      expect(k.zone).toBe(2)
      expect(k.dive).toBe(0)
    }
  })

  test('observe counts goals, kicks taken, rounds and per-kick outcomes from each seat', () => {
    const s = withGoals([T, F, F, T, T])
    const o0 = core.observe(s, 0)
    const o1 = core.observe(s, 1)
    expect(o0.goals).toEqual([2, 1])
    expect(o1.goals).toEqual([1, 2])
    expect(o0.taken).toEqual([3, 2])
    expect(o1.taken).toEqual([2, 3])
    expect(o0.round).toBe(3)
    expect(o0.sudden).toBe(false)
    expect(o0.role).toBe('keeper')
    expect(o1.role).toBe('shooter')
    expect(o0.kicks.map((k) => k.byMe)).toEqual([true, false, true, false, true])
    expect(o0.kicks.map((k) => k.outcome)).toEqual(['goal', 'wide', 'wide', 'goal', 'goal'])
    expect(o0.over).toBe(false)
  })

  test('a save is a miss with matching zones, wide is a miss otherwise', () => {
    const miss = (zone: Zone, dive: Zone): PenaltyState => ({ seed: 0, kicks: [{ kicker: 0, zone, dive, goal: false }] })
    expect(core.observe(miss(1, 1), 0).kicks[0].outcome).toBe('save')
    expect(core.observe(miss(0, 2), 0).kicks[0].outcome).toBe('wide')
    // A goal with matching zones (table cells 50 and 100 per mille) is still a goal.
    const hit = (zone: Zone, dive: Zone): PenaltyState => ({ seed: 0, kicks: [{ kicker: 0, zone, dive, goal: true }] })
    expect(core.observe(hit(1, 1), 0).kicks[0].outcome).toBe('goal')
    expect(core.observe(hit(0, 0), 0).kicks[0].outcome).toBe('goal')
    expect(core.observe(hit(1, 1), 0).goals).toEqual([1, 0])
  })

  test('observe carries nothing about the seed or any roll', () => {
    const o = core.observe(withGoals([T, F], 123456), 0)
    expect(Object.keys(o).sort()).toEqual(['goals', 'kicks', 'over', 'role', 'round', 'seat', 'sudden', 'taken'])
    expect(JSON.stringify(o)).not.toContain('123456')
    for (const k of o.kicks) expect(Object.keys(k).sort()).toEqual(['byMe', 'dive', 'outcome', 'zone'])
  })
})

describe('penalty core: when it ends', () => {
  test('five-kick early end at the exact boundary: a lead the other side can still catch does not end it', () => {
    // After 6 kicks (3 each): 2-0 up with 2 kicks left for the other seat is catchable (2 > 0 + 2 is false).
    expect(core.terminal(fromSeats([T, T, F], [F, F, F]))).toBe(false)
    // 3-0 up with 2 kicks left: 3 > 0 + 2 ends it.
    const s = fromSeats([T, T, T], [F, F, F])
    expect(core.terminal(s)).toBe(true)
    expect(core.result(s)).toEqual({ winner: 0, score: [3, 0], reason: 'more goals' })
  })

  test('the same boundary holds for seat 1 leading, including mid-round', () => {
    // After 7 kicks (seat 0 took 4, seat 1 took 3): seat 1 has 3, seat 0 has 0 with 1 kick left: 3 > 1 ends.
    const s = fromSeats([F, F, F, F], [T, T, T])
    expect(s.kicks.length).toBe(7)
    expect(core.terminal(s)).toBe(true)
    expect(core.result(s)?.winner).toBe(1)
    // 2 vs 0 after 7 kicks, one kick left for seat 0: 2 > 0 + 1 also ends it.
    expect(core.terminal(fromSeats([F, F, F, F], [T, T, F]))).toBe(true)
    // 1 vs 0 after 7 kicks: 1 > 0 + 1 is false, still live.
    expect(core.terminal(fromSeats([F, F, F, F], [T, F, F]))).toBe(false)
  })

  test('after five kicks each a goal lead ends it, level goes to sudden death', () => {
    const won = fromSeats([T, F, F, F, F], [F, F, F, F, F])
    expect(won.kicks.length).toBe(10)
    expect(core.terminal(won)).toBe(true)
    const level = fromSeats([T, F, F, F, F], [T, F, F, F, F])
    expect(core.terminal(level)).toBe(false)
    expect(core.toAct(level)).toEqual([0, 1])
    const o = core.observe(level, 0)
    expect(o.sudden).toBe(true)
    expect(o.round).toBe(KICKS + 1)
    expect(o.role).toBe('shooter')
  })

  test('sudden death only ends after a whole round', () => {
    const level = fromSeats([T, F, F, F, F], [T, F, F, F, F])
    // Seat 0 scores in round 6; seat 1 has not shot, so it is not over.
    const half: PenaltyState = { seed: level.seed, kicks: [...level.kicks, { kicker: 0, zone: 0, dive: 1, goal: true }] }
    expect(core.terminal(half)).toBe(false)
    // Seat 1 scores too: level, play on.
    const both: PenaltyState = { seed: level.seed, kicks: [...half.kicks, { kicker: 1, zone: 0, dive: 1, goal: true }] }
    expect(core.terminal(both)).toBe(false)
    // Seat 0 scores and seat 1 misses in the next round: seat 0 wins.
    const next: PenaltyState = {
      seed: level.seed,
      kicks: [...both.kicks, { kicker: 0, zone: 0, dive: 1, goal: true }, { kicker: 1, zone: 0, dive: 1, goal: false }],
    }
    expect(core.terminal(next)).toBe(true)
    expect(core.result(next)).toEqual({ winner: 0, score: [3, 2], reason: 'more goals' })
    // Seat 0 misses and seat 1 scores: seat 1 wins, and only on the second kick of the round.
    const mid: PenaltyState = { seed: level.seed, kicks: [...both.kicks, { kicker: 0, zone: 0, dive: 1, goal: false }] }
    expect(core.terminal(mid)).toBe(false)
    const lost: PenaltyState = { seed: level.seed, kicks: [...mid.kicks, { kicker: 1, zone: 0, dive: 1, goal: true }] }
    expect(core.result(lost)?.winner).toBe(1)
  })

  test('a draw after EXTRA_ROUNDS of sudden death', () => {
    const all = Array.from({ length: 2 * (KICKS + EXTRA_ROUNDS) }, () => F)
    // 32 level kicks (one round short): not terminal, both seats still act.
    const short = withGoals(all.slice(0, -2))
    expect(short.kicks.length).toBe(2 * (KICKS + EXTRA_ROUNDS) - 2)
    expect(core.terminal(short)).toBe(false)
    expect(core.toAct(short)).toEqual([0, 1])
    const almost = withGoals(all.slice(0, -1))
    expect(core.terminal(almost)).toBe(false)
    const drawn = withGoals(all)
    expect(core.terminal(drawn)).toBe(true)
    expect(core.result(drawn)).toEqual({ winner: null, score: [0, 0], reason: 'level after sudden death' })
    expect(core.toAct(drawn)).toEqual([])
  })

  test('round and sudden at the boundaries', () => {
    // 8 level kicks: round 5, not sudden.
    const eight = withGoals([F, F, F, F, F, F, F, F])
    expect(core.observe(eight, 0).round).toBe(KICKS)
    expect(core.observe(eight, 0).sudden).toBe(false)
    // A normal 10-kick win: round 5, not sudden.
    const won = fromSeats([T, F, F, F, F], [F, F, F, F, F])
    const ow = core.observe(won, 0)
    expect(ow.over).toBe(true)
    expect(ow.round).toBe(KICKS)
    expect(ow.sudden).toBe(false)
    // A 12-kick finish: round 6, sudden.
    const level = fromSeats([T, F, F, F, F], [T, F, F, F, F])
    const fin = withGoals([...level.kicks.map((k) => k.goal), T, F])
    const of = core.observe(fin, 0)
    expect(of.over).toBe(true)
    expect(of.round).toBe(KICKS + 1)
    expect(of.sudden).toBe(true)
  })

  test('result is null until over', () => {
    expect(core.result(core.init(1))).toBeNull()
    const o = core.observe(fromSeats([T, T, T], [F, F, F]), 1)
    expect(o.over).toBe(true)
    expect(o.role).toBeNull()
    expect(o.goals).toEqual([0, 3])
  })
})

describe('penalty core: goal table and seed', () => {
  test('each table cell scores within 3 points of its per-mille value over 3,000 kicks', () => {
    for (let zone = 0 as Zone; zone < 3; zone++) {
      for (let dive = 0 as Zone; dive < 3; dive++) {
        let goals = 0
        for (let seed = 0; seed < 3000; seed++) {
          const s = play(core.init(seed * 7 + 11), zone, dive)
          if (s.kicks[0].goal) goals++
        }
        const rate = goals / 3000
        const want = GOAL_PER_MILLE[zone][dive] / 1000
        expect(Math.abs(rate - want)).toBeLessThan(0.03)
      }
    }
  })

  test('the table is the planned one', () => {
    expect(GOAL_PER_MILLE).toEqual([
      [100, 920, 980],
      [700, 50, 700],
      [980, 920, 100],
    ])
    expect(KICKS).toBe(5)
    expect(EXTRA_ROUNDS).toBe(12)
  })

  test('same seed and actions give the same hash; a different seed gives a different roll sequence', () => {
    const run = (seed: number) => {
      let s = core.init(seed)
      for (let i = 0; i < 8 && !core.terminal(s); i++) s = play(s, (i % 3) as Zone, ((i + 1) % 3) as Zone)
      return s
    }
    expect(core.hash(run(5))).toBe(core.hash(run(5)))
    expect(core.hash(run(5))).not.toBe(core.hash(run(6)))
    expect(core.hash(run(5))).toMatch(/^[0-9a-f]{16}$/)
    // Roll sequences differ across seeds: a 50 percent cell gives different goal strings.
    const seqs = new Set<string>()
    for (let seed = 0; seed < 20; seed++) {
      let s = core.init(seed)
      for (let i = 0; i < 6; i++) s = play(s, 1, 0) // 70 percent cell
      seqs.add(s.kicks.map((k) => (k.goal ? '1' : '0')).join(''))
    }
    expect(seqs.size).toBeGreaterThan(5)
  })

  test('the roll belongs to the kick index: it follows the plan formula and ignores earlier kicks', () => {
    const want = (seed: number, k: number, zone: Zone, dive: Zone) =>
      makeRng((seed ^ Math.imul(k + 1, 0x85ebca6b)) | 0).int(1000) < GOAL_PER_MILLE[zone][dive]
    for (const seed of [1, 42, 977, 123456, -5]) {
      for (const k of [1, 3, 6, 9, 10, 11, 12, 21, 32, 33]) {
        for (const zone of [0, 1, 2] as Zone[]) {
          for (const dive of [0, 1, 2] as Zone[]) {
            // Two different histories of k kicks with the same seed (zones and goal flags differ).
            const histA: Kick[] = Array.from({ length: k }, (_, i) => ({ kicker: (i % 2) as 0 | 1, zone: 0, dive: 1, goal: false }))
            const histB: Kick[] = Array.from({ length: k }, (_, i) => ({ kicker: (i % 2) as 0 | 1, zone: 2, dive: 2, goal: i % 4 < 2 }))
            expect(core.terminal({ seed, kicks: histA })).toBe(false)
            expect(core.terminal({ seed, kicks: histB })).toBe(false)
            const kicker = (k % 2) as 0 | 1
            const acts: [Zone, Zone] = kicker === 0 ? [zone, dive] : [dive, zone]
            const a = core.step({ seed, kicks: histA }, acts).kicks[k]
            const b = core.step({ seed, kicks: histB }, acts).kicks[k]
            expect(a.goal).toBe(b.goal)
            expect(a.goal).toBe(want(seed, k, zone, dive))
          }
        }
      }
    }
  })
})

describe('penalty core: codes', () => {
  test('codes 0..2 round-trip, anything else throws', () => {
    for (const z of [0, 1, 2] as Zone[]) {
      expect(core.decodeAction(core.encodeAction(z))).toBe(z)
      expect(core.encodeAction(z)).toBe(z)
    }
    expect(() => core.decodeAction(3)).toThrow()
    expect(() => core.decodeAction(-1)).toThrow()
    expect(() => core.decodeAction(0.5)).toThrow()
    expect(() => core.encodeAction(3 as Zone)).toThrow()
  })

  test('a full random match steps through legal, encodeAction and decodeAction', () => {
    const make = createPenaltyCore()
    expect(make.id as string).toBe('penalty')
    expect(make.version).toBe('penalty-1')
    for (let seed = 0; seed < 50; seed++) {
      const rng = makeRng(seed)
      let s = make.init(seed)
      let guard = 0
      while (!make.terminal(s)) {
        const acts: [Zone | null, Zone | null] = [null, null]
        for (const seat of make.toAct(s)) {
          const legal = make.legal(s, seat)
          const code = make.encodeAction(legal[rng.int(legal.length)])
          acts[seat] = make.decodeAction(code)
        }
        s = make.step(s, acts)
        expect(++guard).toBeLessThanOrEqual(2 * (KICKS + EXTRA_ROUNDS))
      }
      const r = make.result(s)
      expect(r).not.toBeNull()
      expect(make.toAct(s)).toEqual([])
      expect(r!.score[0] + r!.score[1]).toBe(s.kicks.filter((k) => k.goal).length)
    }
  })
})
