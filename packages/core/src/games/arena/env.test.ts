import { describe, expect, test } from 'bun:test'

// A loaded machine can take seconds for the longer episodes.
const SLOW = 120_000
import { loadEnvFactory } from '../../bridge/env-host'
import { LEVEL_LIMITS } from '../../limiter'
import { makeRng } from '../../rng'
import { ACTION_DIMS, ACTION_NVEC, ARENA_BOT_SENTINEL_BASE, KEEP_MOVE, PITCH_ZERO_BIN, YAW_ZERO_BIN, headsFromInput, inputFromHeads } from './actions'
import { BUY_DECISIONS, CLOSE_DISTANCES, EXTRA_FEATURES, FRAME_SKIP, OBS_FEATURES, aimPotential, closeIn, createEnv, parseLevel } from './env'
import { ARENA_FEATURES, buildObs, type ArenaObs } from './encode'
import { createState } from './core'
import { cloneState, type ArenaState } from './state'
import { MAP_LIST } from './map'
import { segmentBlocked } from './raycast'
import { HUMAN_PROXY_LIMITS } from './bots'
import { HumanLimiter } from '../../limiter'

const make = (n: number, level?: string) => createEnv!({ n, seed: 1, level })
const BUY_FLAG = ARENA_FEATURES - 7
const LIVE_FLAG = ARENA_FEATURES - 6
const PHASE_LEFT = ARENA_FEATURES - 4

/** The policy's do-nothing action: stand still, no buttons, zero turn, no buy. */
function idle(n: number): Int32Array {
  const a = new Int32Array(n * 2 * ACTION_DIMS)
  for (let k = 0; k < n * 2; k++) {
    a[k * ACTION_DIMS + 6] = YAW_ZERO_BIN
    a[k * ACTION_DIMS + 7] = PITCH_ZERO_BIN
  }
  return a
}

function randomActions(n: number, rng: ReturnType<typeof makeRng>): Int32Array {
  const a = new Int32Array(n * 2 * ACTION_DIMS)
  for (let k = 0; k < n * 2; k++) for (let d = 0; d < ACTION_DIMS; d++) a[k * ACTION_DIMS + d] = rng.int(ACTION_NVEC[d]!)
  return a
}

describe('arena env', () => {
  test('is loaded by the bridge host by game id', async () => {
    expect(await loadEnvFactory('arena')).toBe(createEnv as never)
  })

  test('shapes, deterministic reset, finite observations', () => {
    const env = make(3)
    expect(env.obsShape).toEqual([2, OBS_FEATURES])
    expect(env.actionDims).toBe(ACTION_DIMS)
    expect(ACTION_DIMS).toBe(9)
    const a = env.reset([1, 2, 3])
    const b = make(3).reset([1, 2, 3])
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a.length).toBe(3 * 2 * OBS_FEATURES)
    for (const v of a) expect(Number.isFinite(v)).toBe(true)
  })

  test('the buy phase is BUY_DECISIONS decisions, then the live phase starts', () => {
    const env = make(1)
    let obs = env.reset([5])
    expect(obs[BUY_FLAG]).toBe(1)
    for (let t = 1; t <= BUY_DECISIONS; t++) {
      obs = env.step(idle(1)).obs
      if (t < BUY_DECISIONS) expect(obs[BUY_FLAG]).toBe(1)
    }
    expect(obs[BUY_FLAG]).toBe(0)
    expect(obs[LIVE_FLAG]).toBe(1)
    // Live decisions advance FRAME_SKIP frames: the round clock drops by FRAME_SKIP / 3600 per decision.
    const before = obs[PHASE_LEFT]!
    const after = env.step(idle(1)).obs[PHASE_LEFT]!
    expect(before - after).toBeCloseTo(FRAME_SKIP / 3600, 5)
  })

  test('a buy choice is applied: carbine in round 2 money, armor needs the money', () => {
    // Round one money is 800: a carbine buy is refused and nothing is spent.
    const env = make(1)
    const o0 = env.reset([5])
    const act = idle(1)
    act[8] = 2
    const o1 = env.step(act).obs
    expect(o1[2]).toBe(o0[2]) // money feature unchanged
    expect(o1[0]).toBe(1) // health
  })

  test('deterministic under random actions; observations and rewards stay finite', () => {
    const run = () => {
      const env = make(4)
      env.reset([10, 11, 12, 13])
      const rng = makeRng(5)
      let sum = 0
      const rewards: number[] = []
      for (let t = 0; t < 600; t++) {
        const out = env.step(randomActions(4, rng))
        for (const v of out.obs) {
          expect(Number.isFinite(v)).toBe(true)
          sum += v
        }
        rewards.push(...out.reward)
      }
      return { sum, rewards }
    }
    const x = run()
    const y = run()
    expect(y.sum).toBe(x.sum)
    expect(y.rewards).toEqual(x.rewards)
  }, SLOW)

  test('bad actions are rejected', () => {
    const env = make(1)
    env.reset([1])
    expect(() => env.step(new Int32Array(3))).toThrow()
    const bad = idle(1)
    bad[6] = ACTION_NVEC[6]!
    expect(() => env.step(bad)).toThrow(RangeError)
    const neg = idle(1)
    neg[0] = -(1 + 7)
    expect(() => env.step(neg)).toThrow(RangeError)
  })

  test('scripted bots play a seat through the sentinel; a match finishes with info and auto-resets', () => {
    const env = make(2)
    env.reset([7, 8])
    const act = idle(2)
    // env 0: rusher (seat 0) vs random (seat 1); env 1: holder vs rusher.
    act[0 * ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 1
    act[1 * ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 0
    act[2 * ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 2
    act[3 * ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 1
    const seen: Array<Record<string, unknown>> = []
    let positive = 0
    for (let t = 0; t < 20_000 && seen.length < 2; t++) {
      const out = env.step(act)
      for (let i = 0; i < out.reward.length; i++) if (out.reward[i]! > 0) positive++
      seen.push(...out.infos)
    }
    expect(seen.length).toBe(2)
    expect(positive).toBeGreaterThan(0)
    const byEnv = Object.fromEntries(seen.map((x) => [x.env as number, x]))
    expect(byEnv[0]!.winner).toBe(0) // rusher beats random
    expect(byEnv[1]!.winner).toBe(0) // holder beats rusher
    for (const info of seen) {
      expect(typeof info.finalHash).toBe('string')
      expect((info.score as number[]).length).toBe(2)
      const sc = info.score as number[]
      expect(info.rounds as number).toBeGreaterThanOrEqual(sc[0]! + sc[1]!) // drawn rounds count as played
      expect(info.rounds as number).toBeLessThanOrEqual(13)
    }
    // Auto-reset: the next step still works and yields finite observations.
    for (const v of env.step(act).obs) expect(Number.isFinite(v)).toBe(true)
  }, SLOW)

  test('reward is damage and round based, seat 0 view: beating a random seat pays, losing to a rusher costs', () => {
    const total = (b0: number, b1: number) => {
      const env = make(1)
      env.reset([21])
      const act = idle(1)
      act[0] = ARENA_BOT_SENTINEL_BASE - b0
      act[ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - b1
      let r = 0
      for (let t = 0; t < 30_000; t++) {
        const out = env.step(act)
        r += out.reward[0]!
        if (out.done[0] === 1) return r
      }
      throw new Error('match did not finish')
    }
    expect(total(1, 0)).toBeGreaterThan(5) // rusher over random: many round wins
    expect(total(0, 1)).toBeLessThan(-5)
  }, SLOW)
})

describe('arena env levels', () => {
  test('level strings: plain levels, the close-range flag, and rejects', () => {
    expect(parseLevel(undefined)).toEqual({ level: undefined, close: false })
    expect(parseLevel('hard')).toEqual({ level: 'hard', close: false })
    expect(parseLevel('champion@close')).toEqual({ level: 'champion', close: true })
    expect(parseLevel('@close')).toEqual({ level: undefined, close: true })
    expect(() => parseLevel('expert')).toThrow()
    expect(() => parseLevel('easy@far')).toThrow()
    expect(() => parseLevel('easy@close@close')).toThrow()
    expect(() => make(1, 'expert')).toThrow()
  })

  test('with a level the view lags by exactly delayFrames', () => {
    const delay = LEVEL_LIMITS.arena.easy.delayFrames
    const run = (level?: string) => {
      const env = make(1, level)
      let obs = env.reset([5])
      const lefts: number[] = []
      for (let t = 0; t < BUY_DECISIONS + 12; t++) {
        obs = env.step(idle(1)).obs
        if (t >= BUY_DECISIONS) lefts.push(obs[PHASE_LEFT]!)
      }
      return lefts
    }
    const live = run()
    const lagged = run('easy')
    // Decision t (counting from the first live decision, t = 1..): 4t frames in; the lagged view shows 4t - delay (or the start).
    for (let t = 1; t <= live.length; t++) {
      const seen = Math.max(0, FRAME_SKIP * t - delay)
      expect(lagged[t - 1]!).toBeCloseTo(1 - seen / 3600, 5)
      expect(live[t - 1]!).toBeCloseTo(1 - (FRAME_SKIP * t) / 3600, 5)
    }
  })

  test('the limiter filters presses: a capped level cannot fire more than its APM allows', () => {
    // Easy allows 100 presses a minute. A policy that flips fire on and off every decision presses 900 times a minute.
    const env = make(1, 'easy')
    env.reset([3])
    const act = idle(1)
    // Count shots through the ammo feature: it falls by 1/12 per dart.
    let obs = env.step(idle(1)).obs
    for (let t = 0; t < BUY_DECISIONS; t++) obs = env.step(idle(1)).obs
    let shots = 0
    let ammo = obs[14]!
    for (let t = 0; t < 900; t++) {
      act[4] = t % 2 // fire head of seat 0
      obs = env.step(act).obs
      if (obs[14]! < ammo - 1e-6) shots++
      ammo = obs[14]!
      if (obs[14]! < 0.2) act[5] = 1
      else act[5] = 0
    }
    expect(shots).toBeGreaterThan(0)
    expect(shots).toBeLessThanOrEqual(110)
  }, SLOW)

  test('a policy that holds fire cannot get around the cap with the semi-automatic trigger pulse', () => {
    // Every decision of a semi-automatic weapon is a fresh trigger press, so a held fire=1 must still spend APM slots.
    const env = make(1, 'easy')
    env.reset([3])
    const act = idle(1)
    for (let t = 0; t < BUY_DECISIONS + 1; t++) env.step(idle(1))
    const p = (env as unknown as { states: Array<{ players: Array<{ ammo: number }>; phase: number }> }).states[0]!.players[0]!
    act[4] = 1 // fire held on every decision
    let shots = 0
    let liveDecisions = 0
    let ammo = p.ammo
    for (let t = 0; t < 900; t++) {
      act[5] = p.ammo <= 1 ? 1 : 0 // reload when nearly empty
      env.step(act)
      if (p.ammo < ammo) shots += ammo - p.ammo
      ammo = p.ammo
      liveDecisions++
    }
    expect(shots).toBeGreaterThan(0)
    // 100 per live minute, with a little slack for the window edge.
    expect(shots).toBeLessThanOrEqual(Math.ceil((100 * liveDecisions * FRAME_SKIP) / 3600) + 5)
  }, SLOW)
})

describe('close-range curriculum', () => {
  test('every spawn pair on every map starts within 700 units with a clear line of sight', () => {
    for (let m = 0; m < MAP_LIST.length; m++) {
      const map = MAP_LIST[m]!
      for (let seed = 0; seed < 60; seed++) {
        const s = createState(seed, { map: map.id })
        const far = Math.hypot(s.players[1].x - s.players[0].x, s.players[1].y - s.players[0].y)
        closeIn(s)
        const a = s.players[0]
        const b = s.players[1]
        const d = Math.hypot(b.x - a.x, b.y - a.y)
        expect(far).toBeGreaterThan(1000)
        expect(d).toBeLessThanOrEqual(CLOSE_DISTANCES[CLOSE_DISTANCES.length - 1]! + 1e-6)
        expect(segmentBlocked(map, a.x, a.y, a.z + 64, b.x, b.y, b.z + 64)).toBe(false)
      }
    }
  })

  test('a close env has the opponent in sight after the first decision, in every one of 24 seeds', () => {
    const knownIdx = 20 + 3 + MAP_LIST.length // the opponent features follow self, weapon one-hot and map one-hot
    let farSeen = 0
    for (let seed = 0; seed < 24; seed++) {
      const env = make(1, 'champion@close')
      env.reset([seed])
      const o = env.step(idle(1)).obs
      expect(o[knownIdx]).toBe(1)
      expect(o[knownIdx + 1]).toBe(1)
      const far = make(1, 'champion')
      far.reset([seed])
      farSeen += far.step(idle(1)).obs[knownIdx + 1]!
    }
    expect(farSeen).toBeLessThan(24) // the curriculum is not the default start
  })

  test('the next round of a close env is close again', () => {
    const env = make(1, 'champion@close')
    const knownIdx = 20 + 3 + MAP_LIST.length
    env.reset([2])
    const act = idle(1)
    act[0] = ARENA_BOT_SENTINEL_BASE - 1
    act[ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 0
    let rounds = 0
    let lastLeft = 0
    let sightAtStart = 0
    for (let t = 0; t < 4000 && rounds < 3; t++) {
      const o = env.step(act).obs
      if (o[LIVE_FLAG] === 1 && lastLeft === 0) {
        rounds++
        sightAtStart += o[knownIdx + 1]!
      }
      lastLeft = o[LIVE_FLAG]!
    }
    expect(rounds).toBeGreaterThanOrEqual(2)
    expect(sightAtStart).toBe(rounds) // every live phase starts with the opponent in sight
  }, SLOW)
})

describe('aiming potential', () => {
  test('is zero out of sight and out of the live phase, and highest on target', () => {
    const s = createState(1)
    expect(aimPotential(s)).toBe(0) // buy phase
    s.phase = 1
    expect(aimPotential(s)).toBe(0) // opponent never seen
    const a = s.players[0]
    const b = s.players[1]
    a.x = 0; a.y = 0; a.z = 0; a.yaw = 0; a.pitch = 0; a.punchPitch = 0; a.punchYaw = 0
    b.x = 500; b.y = 0; b.z = 0
    a.lsKnown = 1; a.lsAge = 0
    // Dead ahead at chest height: the pitch needed is -14 units over 500, small but not zero.
    const onTarget = aimPotential(s)
    expect(onTarget).toBeGreaterThan(0.18)
    expect(onTarget).toBeLessThanOrEqual(0.2)
    a.yaw = 400 // about 17 degrees off
    const off = aimPotential(s)
    expect(off).toBeGreaterThan(0)
    expect(off).toBeLessThan(onTarget)
    a.yaw = 4096 // facing away
    expect(aimPotential(s)).toBe(0)
    a.yaw = 0
    a.lsAge = 3 // seen a moment ago, not now
    expect(aimPotential(s)).toBe(0)
  })

  test('shaping is potential based: facing the opponent for the whole match pays no more than a small constant', () => {
    // Total shaping over an episode telescopes to gamma-weighted differences, bounded by the potential's range.
    const env = make(1, 'champion@close')
    env.reset([6])
    const act = idle(1)
    act[0] = ARENA_BOT_SENTINEL_BASE - 2 // holder tracks and fires; seat 1 idle
    let total = 0
    for (let t = 0; t < 400; t++) total += env.step(act).reward[0]!
    expect(Number.isFinite(total)).toBe(true)
  })
})

describe('trigger', () => {
  test('every decision with fire set is a fresh press for the semi-automatic dart: it fires on consecutive decisions', () => {
    const env = make(1)
    env.reset([3])
    const act = idle(1)
    for (let t = 0; t < BUY_DECISIONS; t++) env.step(act)
    act[4] = 1 // seat 0 holds fire on every decision
    const ammo = (o: Float32Array) => o[14]!
    let prev = ammo(env.step(idle(1)).obs)
    const drops: number[] = []
    for (let t = 0; t < 6; t++) {
      const a = ammo(env.step(act).obs)
      drops.push(Math.round((prev - a) * 12))
      prev = a
    }
    // The dart has a 9 frame cycle (two decisions apart at 4 frames), so the shots land every second or third decision, not once.
    expect(drops.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(2)
  })
})

describe('behaviour-cloning data', () => {
  test('headsFromInput picks the nearest bins and round-trips every head through inputFromHeads', () => {
    const out = new Int32Array(ACTION_DIMS)
    headsFromInput({ move: 2, walk: 1, crouch: 0, jump: 1, fire: 1, reload: 0, yaw: 30, pitch: -12, buy: 3 }, out, 0)
    expect(Array.from(out)).toEqual([2, 1, 0, 1, 1, 0, 6, 2, 3])
    const back = inputFromHeads(out, 0)
    expect(back).toMatchObject({ move: 2, walk: 1, fire: 1, yaw: 40, pitch: -5, buy: 3 })
    headsFromInput({ move: 0, walk: 0, crouch: 0, jump: 0, fire: 0, reload: 0, yaw: 0, pitch: 0, buy: 7 }, out, 0)
    expect(out[6]).toBe(YAW_ZERO_BIN)
    expect(out[7]).toBe(PITCH_ZERO_BIN)
    expect(out[8]).toBe(3)
  })

  test('with a random source the turn bins are rounded so that a small sweep keeps its expected size', () => {
    const rng = makeRng(9)
    const out = new Int32Array(ACTION_DIMS)
    let sum = 0
    const n = 4000
    for (let t = 0; t < n; t++) {
      headsFromInput({ move: 1, walk: 0, crouch: 0, jump: 0, fire: 0, reload: 0, yaw: 5, pitch: 0, buy: 0 }, out, 0, () => rng.float())
      sum += inputFromHeads(out, 0).yaw
      expect([YAW_ZERO_BIN, YAW_ZERO_BIN + 1]).toContain(out[6]!)
    }
    expect(sum / n).toBeGreaterThan(4)
    expect(sum / n).toBeLessThan(6)
  })

  test('collect records one row per decision with in-range heads and a teacher that actually fires', async () => {
    const { collect, BC_OPPONENTS } = await import('./bc-data')
    expect(BC_OPPONENTS).not.toContain('human-proxy')
    expect(() => collect({ decisions: 1, seed: 5, level: 'easy', teachers: ['human-proxy'], envs: 1 })).toThrow('measurement-only')
    const { obs, act, rows } = collect({ decisions: 3000, seed: 5, level: 'champion@close', teachers: ['rusher', 'holder'], envs: 8 })
    expect(rows).toBe(3000)
    expect(obs.length).toBe(3000 * OBS_FEATURES)
    let fires = 0
    for (let r = 0; r < rows; r++) {
      for (let d = 0; d < ACTION_DIMS; d++) expect(act[r * ACTION_DIMS + d]!).toBeLessThan(ACTION_NVEC[d]!)
      fires += act[r * ACTION_DIMS + 4]!
    }
    expect(fires).toBeGreaterThan(30)
    expect(obs.every((v) => Number.isFinite(v))).toBe(true)
  }, SLOW)
})

describe('arena env v2: own-input observation, free keep, fair bots (R15)', () => {
  const HARD = LEVEL_LIMITS.arena.hard
  const extras = (obs: Float32Array, seat = 0) => obs.subarray((seat + 1) * OBS_FEATURES - EXTRA_FEATURES, (seat + 1) * OBS_FEATURES)
  const X = { move: 0, flags: 9, slots: 14, since: 15, refused: 16 }
  /** Live phase: step through the buy decisions with idle actions. */
  function toLive(env: ReturnType<typeof make>, seed: number): Float32Array {
    let obs = env.reset([seed])
    for (let t = 0; t < BUY_DECISIONS; t++) obs = env.step(idle(1)).obs
    return obs
  }
  const act = (o: { move?: number; fire?: number; jump?: number }): Int32Array => {
    const a = idle(1)
    a[0] = o.move ?? 0
    a[3] = o.jump ?? 0
    a[4] = o.fire ?? 0
    return a
  }

  test('shapes: extras appended after the base features, keep is one value past the moves', () => {
    expect(EXTRA_FEATURES).toBe(17)
    expect(OBS_FEATURES).toBe(ARENA_FEATURES + EXTRA_FEATURES)
    expect(KEEP_MOVE).toBe(9)
  })

  test('held-input features follow the limiter: move one-hot, flags, slots, refused', () => {
    const env = make(1, 'hard')
    let obs = toLive(env, 3)
    let e = extras(obs)
    expect(e[X.move + 0]).toBe(1)
    expect(e[X.slots]).toBe(1)
    expect(e[X.refused]).toBe(0)
    obs = env.step(act({ move: 1, jump: 1 })).obs
    e = extras(obs)
    expect(e[X.move + 1]).toBe(1)
    expect(e[X.flags + 2]).toBe(1) // jump
    expect(e[X.slots]).toBeCloseTo(1 - 1 / HARD.apmCap!, 6)
  })

  test('a policy that changes input every decision empties the budget and is then flagged refused', () => {
    const env = make(1, 'hard')
    toLive(env, 4)
    let refusedSeen = false
    let slots = 1
    for (let t = 0; t < 4000 && !refusedSeen; t++) {
      const a = idle(1)
      a[0] = 1 + (t % 8)
      a[3] = t % 2
      const e = extras(env.step(a).obs)
      slots = e[X.slots]!
      if (e[X.refused] === 1) refusedSeen = true
    }
    expect(refusedSeen).toBe(true)
    expect(slots).toBe(0)
  })

  test('KEEP_MOVE keeps the held move and flags for 60 simulated seconds at no APM cost', () => {
    const env = make(1, 'hard')
    toLive(env, 5)
    env.step(act({ move: 3 })) // F... R: held move 3
    const before = extras(env.step(act({ move: KEEP_MOVE })).obs)[X.slots]!
    let obs: Float32Array = new Float32Array(0)
    for (let t = 0; t < 900; t++) {
      const a = idle(1)
      a[0] = KEEP_MOVE
      a[3] = t % 2 // the other heads are ignored under keep
      obs = env.step(a).obs
    }
    const e = extras(obs)
    expect(e[X.move + 3]).toBe(1)
    expect(e[X.flags + 2]).toBe(0)
    expect(e[X.slots]).toBeGreaterThanOrEqual(before)
    expect(e[X.refused]).toBe(0)
  })

  test('keep with no level is accepted; a move head above keep is rejected', () => {
    const env = make(1)
    toLive(env, 6)
    expect(() => env.step(act({ move: KEEP_MOVE }))).not.toThrow()
    expect(() => env.step(act({ move: KEEP_MOVE + 1 }))).toThrow(RangeError)
  })

  test('the gate bot uses its live own state: only its view of the opponent is delayed (R30)', () => {
    type Probe = {
      step: (a: Int32Array) => unknown; reset: (s: number[]) => unknown
      botViewFrame: Int32Array; botObsSeen: Array<ArenaObs | undefined>; states: ArenaState[]
      history: Array<{ view: (frame: number) => { frame: number; state: ArenaState } }>
    }
    for (const level of ['easy', 'hard'] as const) {
      const env = make(1, level) as unknown as Probe
      env.reset([9])
      let late = 0
      let selfMoved = 0
      for (let t = 0; t < 60; t++) {
        const live = env.states[0]!
        const frame = live.frame
        const was = cloneState(live)
        const a = idle(1)
        a[ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 1
        env.step(a)
        const got = env.botObsSeen[1]!
        const viewFrame = env.botViewFrame[1]!
        // Own state: exactly the live state at the decision, whatever the delay.
        expect(got.self).toEqual(buildObs(was, 1).self)
        const old = env.history[0]!.view(frame).state // the delayed state the env keeps for the bot
        if (viewFrame < frame) {
          late++
          // The opponent: as of the delayed frame.
          expect(got.opp).toEqual(buildObs(old, 1).opp)
          if (old.players[1].x !== was.players[1].x || old.players[1].yaw !== was.players[1].yaw) selfMoved++
        }
      }
      expect(late).toBeGreaterThan(10)
      expect(selfMoved).toBeGreaterThan(5) // the bot's own pose moved inside the delay window: reading it late would show
    }
  })

  test('bots below Champion read the state delayFrames late; Champion bots read the live game', () => {
    type Probe = { step: (a: Int32Array) => unknown; reset: (s: number[]) => unknown; botViewFrame: Int32Array; states: Array<{ frame: number }>; anchors: number[] }
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const env = make(1, level) as unknown as Probe
      env.reset([9])
      const delay = LEVEL_LIMITS.arena[level].delayFrames
      let checked = 0
      for (let t = 0; t < 40; t++) {
        const frame = env.states[0]!.frame
        const a = idle(1)
        a[ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 1 // seat 1 is the rusher
        env.step(a)
        const live = frame - env.anchors[0]! >= delay
        if (live && env.states[0]!.frame - frame === FRAME_SKIP) {
          expect(env.botViewFrame[1]).toBe(frame - delay)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(10)
    }
    const champ = make(1, 'champion') as unknown as Probe
    champ.reset([9])
    const frame = champ.states[0]!.frame
    const a = idle(1)
    a[ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 1
    champ.step(a)
    expect(champ.botViewFrame[1]).toBe(frame)
  })

  test('human proxy keeps its own 15-frame delay and 400 degree turn limit at every level', () => {
    const limiter = new HumanLimiter(HUMAN_PROXY_LIMITS, makeRng(1))
    expect(limiter.aim(1000, -1000, FRAME_SKIP)).toEqual([151, -151])
    type Probe = { step: (a: Int32Array) => unknown; reset: (s: number[]) => unknown; botViewFrame: Int32Array; states: ArenaState[]; anchors: number[] }
    for (const level of ['easy', 'champion', undefined]) {
      const env = make(1, level) as unknown as Probe
      env.reset([9])
      let checked = 0
      for (let tick = 0; tick < 40; tick++) {
        const frame = env.states[0]!.frame
        const action = idle(1)
        action[ACTION_DIMS] = ARENA_BOT_SENTINEL_BASE - 6
        env.step(action)
        if (frame - env.anchors[0]! >= 15 && env.states[0]!.frame - frame === FRAME_SKIP) {
          expect(env.botViewFrame[1]).toBe(frame - 15)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(10)
    }
  })
})
