import { describe, expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import { replay } from '../../replay'
import type { MatchRecordV1 } from '../../match-record'
import type { GameId } from '../../product'
import { DIVES, EXTRA_ROUNDS, GOAL_PER_MILLE, KICKS, ON_TARGET_PER_MILLE, ZONES, createPenaltyCore, penaltyCore, type Dive, type Kick, type PenaltyState, type Zone } from './index'

const core = penaltyCore

/** A state with the given goal flags, kick 0 by seat 0, then alternating. Zones are irrelevant to the end rules. */
function withGoals(flags: boolean[], seed = 1): PenaltyState {
  const kicks: Kick[] = flags.map((goal, i) => ({ kicker: (i % 2) as 0 | 1, zone: 0, dive: 1, goal, onTarget: goal }))
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
      // The shooter has nine zones, the keeper five dives, and the two swap every kick.
      const shooter = s.kicks.length % 2
      expect(core.legal(s, shooter as 0 | 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
      expect(core.legal(s, (1 - shooter) as 0 | 1)).toEqual([0, 1, 2, 3, 4])
      s = shooter === 0 ? play(s, rng.int(9) as Zone, rng.int(5) as Zone) : play(s, rng.int(5) as Zone, rng.int(9) as Zone)
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
    // Seat 0 shoots here: zones run to 8, seat 1's dive only to 4.
    expect(core.step(s, [8, 4]).kicks[0]).toMatchObject({ zone: 8, dive: 4 })
    expect(() => core.step(s, [9 as Zone, 0])).toThrow()
    expect(() => core.step(s, [0, 5 as Zone])).toThrow(/bad dive/)
    expect(() => core.step(core.step(s, [0, 0]), [5 as Zone, 0])).toThrow(/bad dive/)
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
      // The shooter picks zone 7, the keeper picks dive 3.
      s = shooter === 0 ? play(s, 7, 3) : play(s, 3, 7)
      const k = s.kicks[i]
      expect(k.kicker).toBe(shooter)
      expect(k.zone).toBe(7)
      expect(k.dive).toBe(3)
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

  test('a save is on target and no goal, wide is off target, and the dive plays no part in the word', () => {
    const kick = (zone: Zone, dive: Dive, goal: boolean, onTarget: boolean): PenaltyState => ({ seed: 0, kicks: [{ kicker: 0, zone, dive, goal, onTarget }] })
    expect(core.observe(kick(4, 2, false, true), 0).kicks[0].outcome).toBe('save')
    expect(core.observe(kick(0, 0, false, false), 0).kicks[0].outcome).toBe('wide')
    // Off target against the keeper's own best dive is still wide; on target against a far dive is still a save word if the flag says so.
    expect(core.observe(kick(8, 4, false, false), 0).kicks[0].outcome).toBe('wide')
    expect(core.observe(kick(0, 4, false, true), 0).kicks[0].outcome).toBe('save')
    // A goal into the keeper's best dive is still a goal.
    expect(core.observe(kick(4, 2, true, true), 0).kicks[0].outcome).toBe('goal')
    expect(core.observe(kick(0, 0, true, true), 0).kicks[0].outcome).toBe('goal')
    expect(core.observe(kick(4, 2, true, true), 0).goals).toEqual([1, 0])
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
    const half: PenaltyState = { seed: level.seed, kicks: [...level.kicks, { kicker: 0, zone: 0, dive: 1, goal: true, onTarget: true }] }
    expect(core.terminal(half)).toBe(false)
    // Seat 1 scores too: level, play on.
    const both: PenaltyState = { seed: level.seed, kicks: [...half.kicks, { kicker: 1, zone: 0, dive: 1, goal: true, onTarget: true }] }
    expect(core.terminal(both)).toBe(false)
    // Seat 0 scores and seat 1 misses in the next round: seat 0 wins.
    const next: PenaltyState = {
      seed: level.seed,
      kicks: [...both.kicks, { kicker: 0, zone: 0, dive: 1, goal: true, onTarget: true }, { kicker: 1, zone: 0, dive: 1, goal: false, onTarget: false }],
    }
    expect(core.terminal(next)).toBe(true)
    expect(core.result(next)).toEqual({ winner: 0, score: [3, 2], reason: 'more goals' })
    // Seat 0 misses and seat 1 scores: seat 1 wins, and only on the second kick of the round.
    const mid: PenaltyState = { seed: level.seed, kicks: [...both.kicks, { kicker: 0, zone: 0, dive: 1, goal: false, onTarget: false }] }
    expect(core.terminal(mid)).toBe(false)
    const lost: PenaltyState = { seed: level.seed, kicks: [...mid.kicks, { kicker: 1, zone: 0, dive: 1, goal: true, onTarget: true }] }
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
  test('each table cell scores within 3 points of its per-mille value over 3,000 kicks, and goes on target at its own rate', () => {
    for (const zone of ZONES) {
      for (const dive of DIVES) {
        let goals = 0
        let onTarget = 0
        for (let seed = 0; seed < 3000; seed++) {
          const s = play(core.init(seed * 7 + 11), zone, dive)
          if (s.kicks[0].goal) goals++
          if (s.kicks[0].onTarget) onTarget++
        }
        expect(Math.abs(goals / 3000 - GOAL_PER_MILLE[zone][dive] / 1000)).toBeLessThan(0.03)
        expect(Math.abs(onTarget / 3000 - ON_TARGET_PER_MILLE[zone] / 1000)).toBeLessThan(0.03)
      }
    }
  })

  test('the table is the planned one', () => {
    expect(GOAL_PER_MILLE).toEqual([
      [340, 760, 760, 760, 760],
      [480, 760, 220, 480, 760],
      [760, 760, 760, 340, 760],
      [200, 200, 760, 800, 800],
      [780, 780, 30, 780, 780],
      [800, 800, 760, 200, 200],
      [780, 120, 930, 930, 930],
      [800, 480, 120, 800, 480],
      [930, 930, 930, 780, 120],
    ])
    expect(ON_TARGET_PER_MILLE).toEqual([760, 760, 760, 800, 780, 800, 930, 800, 930])
    expect(KICKS).toBe(5)
    expect(EXTRA_ROUNDS).toBe(12)
  })

  test('a goal is always on target, so one roll decides goal, save and wide', () => {
    for (const zone of ZONES) for (const dive of DIVES) expect(GOAL_PER_MILLE[zone][dive]).toBeLessThanOrEqual(ON_TARGET_PER_MILLE[zone])
    for (let seed = 0; seed < 2000; seed++) {
      const k = play(core.init(seed), 0, 0).kicks[0]
      if (k.goal) expect(k.onTarget).toBe(true)
    }
  })

  test('the table is left-right mirror symmetric', () => {
    const mirrorZone = (z: number) => z - (z % 3) + (2 - (z % 3))
    const mirrorDive = [3, 4, 2, 0, 1]
    for (const zone of ZONES) {
      expect(ON_TARGET_PER_MILLE[mirrorZone(zone)]).toBe(ON_TARGET_PER_MILLE[zone])
      for (const dive of DIVES) expect(GOAL_PER_MILLE[mirrorZone(zone)][mirrorDive[dive]]).toBe(GOAL_PER_MILLE[zone][dive])
    }
  })

  test('top corners are harder to save and easier to miss than bottom corners; down the middle is a bluff', () => {
    const savedShare = (zone: Zone) => 1 - Math.min(...GOAL_PER_MILLE[zone]) / ON_TARGET_PER_MILLE[zone]
    for (const [top, bottom] of [[0, 6], [2, 8]] as [Zone, Zone][]) {
      expect(savedShare(top)).toBeLessThan(savedShare(bottom))
      expect(ON_TARGET_PER_MILLE[top]).toBeLessThan(ON_TARGET_PER_MILLE[bottom])
      expect(Math.min(...GOAL_PER_MILLE[top])).toBeGreaterThan(Math.min(...GOAL_PER_MILLE[bottom]))
    }
    // The centre is the worst shot in the goal when the keeper stays, and the best shot in the middle column when the keeper goes.
    expect(GOAL_PER_MILLE[4][2]).toBe(Math.min(...ZONES.map((z) => GOAL_PER_MILLE[z][2])))
    for (const dive of [0, 1, 3, 4]) expect(GOAL_PER_MILLE[4][dive]).toBeGreaterThanOrEqual(Math.max(GOAL_PER_MILLE[1][dive]!, GOAL_PER_MILLE[7][dive]!) - 20)
  })

  test('same seed and actions give the same hash; a different seed gives a different roll sequence', () => {
    const run = (seed: number) => {
      let s = core.init(seed)
      for (let i = 0; i < 8 && !core.terminal(s); i++) s = play(s, (i % 5) as Zone, ((i + 1) % 5) as Zone)
      return s
    }
    expect(core.hash(run(5))).toBe(core.hash(run(5)))
    expect(core.hash(run(5))).not.toBe(core.hash(run(6)))
    expect(core.hash(run(5))).toMatch(/^[0-9a-f]{16}$/)
    // Roll sequences differ across seeds: a 50 percent cell gives different goal strings.
    const seqs = new Set<string>()
    for (let seed = 0; seed < 20; seed++) {
      let s = core.init(seed)
      for (let i = 0; i < 6; i++) s = play(s, 0, 1) // a 76 percent cell for seat 0, 34 to 80 for seat 1
      seqs.add(s.kicks.map((k) => (k.goal ? '1' : '0')).join(''))
    }
    expect(seqs.size).toBeGreaterThan(5)
  })

  test('the roll belongs to the kick index: it follows the plan formula and ignores earlier kicks', () => {
    const want = (seed: number, k: number, zone: Zone, dive: Dive) =>
      makeRng((seed ^ Math.imul(k + 1, 0x85ebca6b)) | 0).int(1000) < GOAL_PER_MILLE[zone][dive]
    const wantOn = (seed: number, k: number, zone: Zone) => makeRng((seed ^ Math.imul(k + 1, 0x85ebca6b)) | 0).int(1000) < ON_TARGET_PER_MILLE[zone]
    for (const seed of [1, 42, 977, 123456, -5]) {
      for (const k of [1, 3, 6, 9, 10, 11, 12, 21, 32, 33]) {
        for (const zone of ZONES) {
          for (const dive of DIVES) {
            // Two different histories of k kicks with the same seed (zones and goal flags differ).
            const histA: Kick[] = Array.from({ length: k }, (_, i) => ({ kicker: (i % 2) as 0 | 1, zone: 0, dive: 1, goal: false, onTarget: false }))
            const histB: Kick[] = Array.from({ length: k }, (_, i) => ({ kicker: (i % 2) as 0 | 1, zone: 2, dive: 2, goal: i % 4 < 2, onTarget: i % 4 < 2 }))
            expect(core.terminal({ seed, kicks: histA })).toBe(false)
            expect(core.terminal({ seed, kicks: histB })).toBe(false)
            const kicker = (k % 2) as 0 | 1
            const acts: [Zone, Zone] = kicker === 0 ? [zone, dive] : [dive, zone]
            const a = core.step({ seed, kicks: histA }, acts).kicks[k]
            const b = core.step({ seed, kicks: histB }, acts).kicks[k]
            expect(a.goal).toBe(b.goal)
            expect(a.goal).toBe(want(seed, k, zone, dive))
            expect(a.onTarget).toBe(b.onTarget)
            expect(a.onTarget).toBe(wantOn(seed, k, zone))
          }
        }
      }
    }
  })
})

describe('penalty core: codes', () => {
  test('codes 0..8 round-trip, anything else throws', () => {
    for (const z of ZONES) {
      expect(core.decodeAction(core.encodeAction(z))).toBe(z)
      expect(core.encodeAction(z)).toBe(z)
    }
    expect(() => core.decodeAction(9)).toThrow()
    expect(() => core.decodeAction(-1)).toThrow()
    expect(() => core.decodeAction(0.5)).toThrow()
    expect(() => core.encodeAction(9 as Zone)).toThrow()
  })

  test('a full random match steps through legal, encodeAction and decodeAction', () => {
    const make = createPenaltyCore()
    expect(make.id as string).toBe('penalty')
    expect(make.version).toBe('penalty-2')
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

/** Plays a random match, returning every state on the way and the per-tick action codes (kicker first is not assumed: [seat 0, seat 1]). */
function randomMatch(seed: number, onState?: (s: PenaltyState) => void): { s: PenaltyState; ticks: [number, number][] } {
  const rng = makeRng(seed * 7919)
  let s = core.init(seed)
  const ticks: [number, number][] = []
  onState?.(s)
  while (!core.terminal(s)) {
    const shooterFirst = s.kicks.length % 2 === 0
    const a = rng.int(shooterFirst ? 9 : 5) as Zone
    const b = rng.int(shooterFirst ? 5 : 9) as Zone
    ticks.push([core.encodeAction(a), core.encodeAction(b)])
    s = play(s, a, b)
    onState?.(s)
  }
  return { s, ticks }
}

describe('penalty core: the hidden choice', () => {
  test('over 500 random matches no observation carries the seed or a roll, and the seed cannot change what a seat sees', () => {
    let checks = 0
    for (let seed = 1; seed <= 500; seed++) {
      // A seed whose decimal digits cannot appear by chance in a small observation.
      const bigSeed = 900_000_000 + seed * 1_003
      randomMatch(bigSeed, (st) => {
        for (const seat of [0, 1] as const) {
          const o = core.observe(st, seat)
          const json = JSON.stringify(o)
          checks++
          expect(Object.keys(o).sort()).toEqual(['goals', 'kicks', 'over', 'role', 'round', 'seat', 'sudden', 'taken'])
          expect(json).not.toContain('seed')
          expect(json).not.toContain('roll')
          expect(json).not.toContain(String(bigSeed))
          for (const k of o.kicks) expect(Object.keys(k).sort()).toEqual(['byMe', 'dive', 'outcome', 'zone'])
          // Same finished kicks under any other seed: identical observation.
          const other: PenaltyState = { seed: (bigSeed ^ 0x5bd1e995) | 0, kicks: st.kicks }
          expect(JSON.stringify(core.observe(other, seat))).toBe(json)
        }
      })
    }
    expect(checks).toBeGreaterThan(10000)
  })

  test('a pending choice is not in the state: toAct names both seats and observe before a tick is the same whatever either side will pick', () => {
    for (let seed = 1; seed <= 60; seed++) {
      randomMatch(seed, (st) => {
        if (core.terminal(st)) return
        const before = [0, 1].map((seat) => JSON.stringify(core.observe(st, seat as 0 | 1)))
        for (const a of DIVES) {
          for (const b of DIVES) {
            core.step(st, [a, b])
            expect([0, 1].map((seat) => JSON.stringify(core.observe(st, seat as 0 | 1)))).toEqual(before)
          }
        }
      })
    }
  })
})

describe('penalty core: real replay() through the borrowed id', () => {
  // replay() reads PRODUCT.games[core.id].kind, and penalty is not a GameId yet: borrow a turn-based id.
  const borrowed = { ...core, id: 'four' as GameId }

  function recordOf(seed: number): MatchRecordV1 {
    const { s, ticks } = randomMatch(seed)
    const actions: MatchRecordV1['actions'] = []
    ticks.forEach((t, i) => {
      actions.push([i, 0, t[0]])
      actions.push([i, 1, t[1]])
    })
    return {
      schema: 1,
      matchId: 'penalty-' + seed,
      game: 'four' as GameId,
      coreVersion: core.version,
      agent: { version: 'test', level: 'easy' },
      seed,
      humanSeat: 0,
      actions,
      result: core.result(s)!,
      finalHash: core.hash(s),
      startedAt: '2026-11-02T00:00:00.000Z',
      endedAt: '2026-11-02T00:01:00.000Z',
      device: 'desktop',
      input: 'mouse',
      trainingAllowed: false,
    }
  }
  const run = (r: MatchRecordV1) => replay(r, { core: borrowed })

  test('200 random matches replay ok, two entries per tick', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = recordOf(seed)
      expect(r.actions.length % 2).toBe(0)
      const out = run(r)
      expect(out.error).toBeUndefined()
      expect(out.ok).toBe(true)
      expect(out.finalHash).toBe(r.finalHash)
    }
  })

  test('a changed zone, a dropped seat action, a kick after the end and a wrong seed each fail', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = recordOf(seed)
      expect(run(r).ok).toBe(true)

      // Changed zone: rotate one action. The roll, the early end or the hash moves, so it never replays ok.
      const i = (seed * 5) % r.actions.length
      const changed = r.actions.map((a) => [...a] as MatchRecordV1['actions'][number])
      changed[i]![2] = (changed[i]![2] + 1) % 5
      const c = run({ ...r, actions: changed })
      expect(c.ok).toBe(false)
      expect(c.error).toMatch(/mismatch|actions after the game ended|record ends/)

      // Dropped seat action: remove one entry.
      const dropped = r.actions.filter((_, j) => j !== i)
      const d = run({ ...r, actions: dropped })
      expect(d.ok).toBe(false)
      expect(d.error).toMatch(/missing action|record ends|out of order|not to act/)

      // A kick after the end: one more tick of entries.
      const lastTick = r.actions[r.actions.length - 1]![0]
      const extra = [...r.actions, [lastTick + 1, 0, 1], [lastTick + 1, 1, 1]] as MatchRecordV1['actions']
      const e = run({ ...r, actions: extra })
      expect(e.ok).toBe(false)
      expect(e.error).toMatch(/actions after the game ended/)

      // Wrong seed.
      const w = run({ ...r, seed: r.seed + 1 })
      expect(w.ok).toBe(false)
    }
  })

  test('an action code outside the seat role is refused as illegal: 9 for the shooter, 5 for the keeper', () => {
    const r = recordOf(3)
    const bad = r.actions.map((a) => [...a] as MatchRecordV1['actions'][number])
    bad[0]![2] = 9
    const out = run({ ...r, actions: bad })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/illegal action 9/)
    const badDive = r.actions.map((a) => [...a] as MatchRecordV1['actions'][number])
    badDive[1]![2] = 5
    const out2 = run({ ...r, actions: badDive })
    expect(out2.ok).toBe(false)
    expect(out2.error).toMatch(/illegal action 5/)
  })
})
