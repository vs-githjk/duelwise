import { describe, expect, test } from 'bun:test'
import { createEnv, ACTION_DIMS, BUTTON_HEAD, EXTRA_FEATURES, FRAME_SKIP, KEEP_BUTTON, OBS_FEATURES, VIEW_FEATURES } from './env'
import { FIGHTER_FEATURES } from './encode'
import { BTN, DIR } from './input'
import { LEVEL_LIMITS } from '../../limiter'
import { makeRng } from '../../rng'
import { loadEnvFactory } from '../../bridge/env-host'
import { agentInputLagFor } from './constants'
import { stepPacked } from './core'
import { copyState, createState, type FighterState } from './state'
import { createBot } from './bots'
import { buildObs } from './encode'
import { viewDirToScreen } from './env'
import { N_DIRS } from './input'

const make = (n: number, level?: string) => createEnv!({ n, seed: 1, level })
const idle = (n: number) => new Int32Array(n * 2 * ACTION_DIMS)

describe('fighter env', () => {
  test('is loaded by the bridge host by game id', async () => {
    expect(await loadEnvFactory('fighter')).toBe(createEnv as never)
  })

  test('shapes, deterministic reset, and the views are mirrored copies of each other', () => {
    const env = make(3)
    expect(env.obsShape).toEqual([2, OBS_FEATURES])
    expect(env.actionDims).toBe(2)
    const a = env.reset([1, 2, 3])
    const b = make(3).reset([1, 2, 3])
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a.length).toBe(3 * 2 * OBS_FEATURES)
    // Fight phase at the first decision (the intro is fast-forwarded).
    const o = OBS_FEATURES
    expect(a[FIGHTER_FEATURES]).toBe(0) // seat 0 not mirrored
    expect(a[o + FIGHTER_FEATURES]).toBe(1) // seat 1 mirrored
  })

  test('a step advances FRAME_SKIP frames and is deterministic under random actions', () => {
    const run = () => {
      const env = make(4)
      env.reset([10, 11, 12, 13])
      const rng = makeRng(5)
      let sum = 0
      const rewards: number[] = []
      for (let t = 0; t < 400; t++) {
        const act = new Int32Array(4 * 2 * 2)
        for (let i = 0; i < act.length; i += 2) {
          act[i] = rng.int(9)
          act[i + 1] = rng.int(7)
        }
        const out = env.step(act)
        for (const v of out.obs) sum += v
        rewards.push(...out.reward)
        for (const v of out.obs) expect(Number.isFinite(v)).toBe(true)
      }
      return { sum, rewards }
    }
    expect(run()).toEqual(run())
    expect(FRAME_SKIP).toBe(4)
  })

  test('the first decision is the first fight frame, and a neutral step moves the timer by FRAME_SKIP frames', () => {
    const env = make(1)
    const a = env.reset([7])
    const b = env.step(idle(1)).obs
    // Index of the timer feature in the self view: timer / ROUND_FRAMES sits after both fighter blocks and dx, dy.
    const idx = (FIGHTER_FEATURES - 9 + 2)
    expect(a[idx]! - b[idx]!).toBeCloseTo(FRAME_SKIP / (99 * 60), 6)
  })

  test('actions out of range are rejected', () => {
    const env = make(1)
    env.reset([1])
    const act = idle(1)
    act[0] = 9
    expect(() => env.step(act)).toThrow(RangeError)
  })

  test('damage dealt gives positive reward and damage taken negative', () => {
    // Seat 0 walks to the opponent and spams heavies against a seat that stands still.
    const play = (attacker: 0 | 1) => {
      const env = make(1)
      env.reset([4])
      let total = 0
      for (let t = 0; t < 120; t++) {
        const act = idle(1)
        const walking = t < 40
        act[attacker * 2] = walking ? DIR.R : DIR.N
        act[attacker * 2 + 1] = walking || t % 2 === 0 ? 0 : BTN.HEAVY
        total += env.step(act).reward[0]!
      }
      return total
    }
    expect(play(0)).toBeGreaterThan(0)
    expect(play(1)).toBeLessThan(0)
  })

  test('the episode reward is the round-score difference plus a bounded damage term, and a KO step carries the round result', () => {
    const n = 4
    const env = make(n)
    env.reset([21, 22, 23, 24])
    const rng = makeRng(99)
    const sums = new Array<number>(n).fill(0)
    let episodes = 0
    let koSteps = 0
    for (let t = 0; t < 6000 && episodes < 12; t++) {
      const act = new Int32Array(n * 2 * 2)
      for (let i = 0; i < act.length; i += 2) {
        act[i] = rng.int(9)
        act[i + 1] = rng.int(7)
      }
      const out = env.step(act)
      for (let i = 0; i < n; i++) {
        sums[i]! += out.reward[i]!
        if (out.done[i] !== 1) continue
        const info = out.infos.find((x) => x.env === i)!
        const [a, b] = info.score as [number, number]
        expect(Math.abs(sums[i]! - (a - b))).toBeLessThanOrEqual(3)
        // The match ends on the step that wins the deciding round.
        if (a > b) {
          expect(out.reward[i]!).toBeGreaterThanOrEqual(1 - 1e-6)
          koSteps++
        } else if (b > a) {
          expect(out.reward[i]!).toBeLessThanOrEqual(-1 + 1e-6)
          koSteps++
        }
        sums[i] = 0
        episodes++
      }
    }
    expect(episodes).toBeGreaterThanOrEqual(8)
    expect(koSteps).toBeGreaterThan(0)
  })

  test('idle matches end by timer, report done and infos, and auto-reset', () => {
    const env = make(2)
    env.reset([1, 2])
    let dones = 0
    const infos: Array<Record<string, unknown>> = []
    for (let t = 0; t < 4000 && dones === 0; t++) {
      const out = env.step(idle(2))
      for (let i = 0; i < 2; i++) if (out.done[i] === 1) dones++
      infos.push(...out.infos)
    }
    expect(dones).toBeGreaterThan(0)
    expect(infos[0]!.finalHash).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof infos[0]!.seed).toBe('number')
    // After auto-reset the next step still works and the env is in the fight phase.
    const out = env.step(idle(2))
    expect(out.obs.length).toBe(2 * 2 * OBS_FEATURES)
  })

  test('unknown level is rejected', () => {
    expect(() => make(1, 'godlike')).toThrow()
  })
})

describe('fighter env with a level', () => {
  const timerIdx = FIGHTER_FEATURES - 9 + 2

  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    test(`${level}: the observation is exactly delayFrames late`, () => {
      const delay = LEVEL_LIMITS.fighter[level].delayFrames
      const env = make(1, level)
      let obs = env.reset([9])
      // Sim time at decision k is anchor + FRAME_SKIP * k; the timer feature falls one frame per frame in FIGHT.
      const timers: number[] = [obs[timerIdx]!]
      for (let k = 1; k <= 12; k++) {
        obs = env.step(idle(1)).obs
        timers.push(obs[timerIdx]!)
      }
      const perFrame = 1 / (99 * 60)
      for (let k = 0; k < timers.length; k++) {
        const wantFrames = Math.max(0, FRAME_SKIP * k - delay)
        expect(timers[k]).toBeCloseTo(1 - wantFrames * perFrame, 5)
      }
    })
  }

  test('easy: the limiter filters the held input (press cap and minimum hold) inside the env', () => {
    const cfg = LEVEL_LIMITS.fighter.easy
    const env = make(1, 'easy')
    env.reset([31])
    const limiter = (env as any).seats[0][0].limiter as { act: (p: number[], f: number) => number[] }
    const realAct = limiter.act.bind(limiter)
    const calls: Array<{ frame: number; held: number[] }> = []
    limiter.act = (p, f) => {
      const held = realAct(p, f)
      calls.push({ frame: f, held })
      return held
    }
    const rng = makeRng(3)
    let proposedChanges = 0
    let steps = 0
    for (let t = 0; t < 3000 && calls.length < 900; t++) {
      const act = idle(1)
      act[0] = 1 + rng.int(8)
      act[1] = rng.int(7)
      env.step(act)
      steps++
    }
    expect(calls.length).toBe(steps) // act() runs on every decision
    const presses: number[] = []
    let prev = [0, 0]
    let lastChange = -1_000_000
    for (const c of calls) {
      if (c.held[0] !== prev[0] || c.held[1] !== prev[1]) {
        expect(c.frame - lastChange).toBeGreaterThanOrEqual(cfg.minHoldFrames)
        lastChange = c.frame
        proposedChanges++
        // R15: a press is a new direction or a newly down button; releases are free.
        if ((c.held[0] !== 0 && c.held[0] !== prev[0]) || (c.held[1] !== 0 && c.held[1] !== prev[1])) presses.push(c.frame)
      }
      prev = c.held
    }
    expect(proposedChanges).toBeGreaterThan(0)
    for (let i = 0; i < presses.length; i++) {
      let j = i
      while (j < presses.length && presses[j]! - presses[i]! < 3600) j++
      expect(j - i).toBeLessThanOrEqual(cfg.apmCap!)
    }
    // The cap actually bites: an unfiltered proposer would press far more often than the cap allows.
    expect(presses.length).toBeLessThan(steps)
  })

  test('the delayed view stays exact for the first decisions after the round-2 anchor', () => {
    const env = make(1, 'medium')
    const delay = LEVEL_LIMITS.fighter.medium.delayFrames
    let obs = env.reset([9])
    const anchors = (env as any).anchors as number[]
    const first = anchors[0]!
    let round2 = false
    for (let t = 0; t < 6000 && !round2; t++) {
      obs = env.step(idle(1)).obs
      if (anchors[0] !== first) round2 = true
    }
    expect(round2).toBe(true)
    const state = (env as any).states[0]
    const perFrame = 1 / (99 * 60)
    for (let k = 0; k <= 12; k++) {
      const frames = state.frame - anchors[0]!
      expect(frames).toBe(FRAME_SKIP * k)
      const wantFrames = Math.max(0, frames - delay)
      expect(obs[timerIdx]!).toBeCloseTo(1 - wantFrames * perFrame, 5)
      obs = env.step(idle(1)).obs
    }
  })

  test('without a level the view is current', () => {
    const env = make(1)
    const a = env.reset([9])
    const b = env.step(idle(1)).obs
    expect(a[FIGHTER_FEATURES - 9 + 2]! - b[FIGHTER_FEATURES - 9 + 2]!).toBeCloseTo(FRAME_SKIP / (99 * 60), 6)
  })
  test('a negative direction hands that seat to a scripted bot (-1 random, -2 rushdown, -3 turtle, -4 zoner, -5 throwloop, -6 backwalk, -7 pokeloop, -8 sweepspam, -9 fireball, -10 throwtap)', () => {
    const run = (dir: number, level?: string) => {
      const env = make(2, level)
      env.reset([31, 32])
      let total = 0
      const rewards: number[] = []
      for (let t = 0; t < 300; t++) {
        const act = idle(2)
        act[2] = dir // env 0, seat 1 is the bot
        act[6] = dir // env 1, seat 1 is the bot
        const out = env.step(act)
        for (const v of out.obs) expect(Number.isFinite(v)).toBe(true)
        total += out.reward[0]! + out.reward[1]!
        rewards.push(out.reward[0]!)
      }
      return { total, rewards }
    }
    // Deterministic per seed, and a rushdown bot against an idle seat 0 deals damage (negative reward for seat 0).
    expect(run(-2)).toEqual(run(-2))
    expect(run(-2).total).toBeLessThan(0)
    expect(run(-2).rewards).not.toEqual(run(-3).rewards)
    expect(run(-1, 'hard').total).toBeDefined()
    for (const d of [-4, -5, -6, -7, -8, -9]) expect(run(d).rewards).toEqual(run(d).rewards)
    expect(run(-4).rewards).not.toEqual(run(-6).rewards)
    // The KC1 bots are real opponents: a poking or sweeping seat deals damage to an idle seat 0, and the three differ from each other.
    expect(run(-7).total).toBeLessThan(0)
    expect(run(-8).total).toBeLessThan(0)
    expect(run(-7).rewards).not.toEqual(run(-8).rewards)
    expect(run(-10).total).toBeLessThan(0)
    expect(make(1).version).toBe('fighter-env-4')
    // Out of the bot range is still rejected.
    const env = make(1)
    env.reset([1])
    const act = idle(1)
    act[2] = -12
    expect(() => env.step(act)).toThrow(RangeError)
  })
})

describe('fighter env v2: own-input observation, free keep, fair bots (R15)', () => {
  const HOLD = LEVEL_LIMITS.fighter.hard
  const extras = (obs: Float32Array, seat = 0) => obs.subarray(seat * OBS_FEATURES + VIEW_FEATURES, (seat + 1) * OBS_FEATURES)
  const act1 = (dir: number, btn: number, dir1 = 0, btn1 = 0) => Int32Array.from([dir, btn, dir1, btn1])
  const ROWS = { dir: 0, btn: 9, slots: 16, since: 17, refused: 18 }

  test('shapes: the extras are appended after the mirrored flag', () => {
    expect(EXTRA_FEATURES).toBe(19)
    expect(VIEW_FEATURES).toBe(FIGHTER_FEATURES + 1)
    expect(OBS_FEATURES).toBe(VIEW_FEATURES + EXTRA_FEATURES)
    expect(make(1, 'hard').obsShape).toEqual([2, OBS_FEATURES])
    expect(BUTTON_HEAD).toBe(8)
  })

  test('held-input features equal what stepPacked received; neutral at the start', () => {
    const env = make(1, 'hard')
    let obs = env.reset([5])
    let e = extras(obs)
    expect(e[ROWS.dir + DIR.N]).toBe(1)
    expect(e[ROWS.btn + BTN.NONE]).toBe(1)
    expect(e[ROWS.slots]).toBe(1)
    expect(e[ROWS.since]).toBe(1)
    expect(e[ROWS.refused]).toBe(0)
    // Seat 0 is not mirrored at the start: DIR.R with LIGHT.
    obs = env.step(act1(DIR.R, BTN.LIGHT)).obs
    e = extras(obs)
    expect(e[ROWS.dir + DIR.R]).toBe(1)
    expect(e[ROWS.btn + BTN.LIGHT]).toBe(1)
    expect(e[ROWS.slots]).toBeCloseTo(1 - 1 / HOLD.apmCap!, 6) // one press (both new, one slot)
    expect(e[ROWS.since]).toBeCloseTo(FRAME_SKIP / 120, 6)
    // The mirrored seat 1 holds the same screen direction in its own view: its view-R is screen-L.
    obs = env.step(act1(DIR.R, BTN.LIGHT, DIR.R, BTN.NONE)).obs
    const e1 = extras(obs, 1)
    expect(e1[ROWS.dir + DIR.R]).toBe(1)
  })

  test('with the hard limiter and a policy that changes input every decision the budget feature reaches 0 within 241 presses, and the next change is flagged refused', () => {
    const env = make(1, 'hard')
    env.reset([6])
    let slots = 1
    let refusedSeen = false
    let obs: Float32Array = new Float32Array(0)
    let presses = 0
    for (let t = 0; t < 4000 && !refusedSeen; t++) {
      // Alternate between two different directions with a fresh button so each decision proposes a new press.
      obs = env.step(act1(1 + (t % 8), 1 + (t % 6))).obs
      const e = extras(obs)
      if (e[ROWS.slots]! < slots) presses++
      slots = e[ROWS.slots]!
      if (e[ROWS.refused] === 1) refusedSeen = true
    }
    expect(refusedSeen).toBe(true)
    expect(slots).toBe(0)
    expect(presses).toBeLessThanOrEqual(HOLD.apmCap!)
    expect(presses).toBeGreaterThan(HOLD.apmCap! - 5)
  })

  test('KEEP_BUTTON holds the current input for 60 simulated seconds and spends no APM slot', () => {
    const env = make(1, 'hard')
    env.reset([7])
    env.step(act1(DIR.R, BTN.NONE))
    const before = extras(env.step(act1(DIR.R, KEEP_BUTTON)).obs)[ROWS.slots]!
    let obs: Float32Array = new Float32Array(0)
    for (let t = 0; t < 900; t++) obs = env.step(act1(1 + (t % 8), KEEP_BUTTON)).obs
    const e = extras(obs)
    expect(e[ROWS.dir + DIR.R]).toBe(1)
    expect(e[ROWS.slots]).toBeGreaterThanOrEqual(before)
    expect(e[ROWS.refused]).toBe(0)
  })

  test('a release costs no slot: pressing then releasing a button while holding a direction', () => {
    const env = make(1, 'hard')
    env.reset([8])
    const a = extras(env.step(act1(DIR.R, BTN.LIGHT)).obs)[ROWS.slots]!
    // minHold at hard is 4 frames = one decision, so the next decision may change.
    const b = extras(env.step(act1(DIR.R, BTN.NONE)).obs)
    expect(b[ROWS.btn + BTN.NONE]).toBe(1)
    expect(b[ROWS.slots]).toBeCloseTo(a, 9)
  })

  test('a button value above the keep value is rejected', () => {
    const env = make(1, 'hard')
    env.reset([1])
    expect(() => env.step(act1(0, KEEP_BUTTON + 1))).toThrow(RangeError)
  })

  test('bots below Champion read the state delayFrames late; Champion bots read the live game', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const env = make(1, level) as unknown as { step: (a: Int32Array) => unknown; reset: (s: number[]) => unknown; botViewFrame: Int32Array; states: Array<{ frame: number }>; anchors: number[] }
      env.reset([21])
      const delay = LEVEL_LIMITS.fighter[level].delayFrames
      let checked = 0
      for (let t = 0; t < 60; t++) {
        const frame = env.states[0]!.frame
        env.step(act1(0, 0, -2, 0)) // seat 1 is the rushdown bot
        const seen = env.botViewFrame[1]!
        if (frame - env.anchors[0]! >= delay) {
          expect(seen).toBe(frame - delay)
          checked++
        } else {
          expect(seen).toBeLessThanOrEqual(frame)
        }
      }
      expect(checked).toBeGreaterThan(20)
    }
    const champ = make(1, 'champion') as unknown as { step: (a: Int32Array) => unknown; reset: (s: number[]) => unknown; botViewFrame: Int32Array; states: Array<{ frame: number }> }
    champ.reset([21])
    const frame = champ.states[0]!.frame
    champ.step(act1(0, 0, -2, 0))
    expect(champ.botViewFrame[1]).toBe(frame)
  })
})

// LC1 (tinderbox-r3): the page holds an agent's decision from the next sim frame, not the frame it was made on, so the env does the same.
describe('fighter env: the agent input lags its decision (LC1)', () => {
  test('the lag is 1 frame on even seeds and 2 on odd ones, and the unlimited env has none', () => {
    expect([agentInputLagFor(2000), agentInputLagFor(2001), agentInputLagFor(0), agentInputLagFor(7)]).toEqual([1, 2, 1, 2])
  })

  for (const seed of [2000, 2001]) {
    test(`seed ${seed}: the first ${agentInputLagFor(seed)} frame(s) of a block still hold the previous input`, () => {
      const lag = agentInputLagFor(seed)
      const env = make(1, 'hard')
      env.reset([seed])
      const sim = (env as unknown as { states: FighterState[] }).states
      const mirror = createState(0)
      copyState(mirror, sim[0]!)
      const act = new Int32Array([DIR.R, BTN.NONE, 0, 0])
      env.step(act)
      // The same four frames by hand: seat 0 holds nothing for `lag` frames, then walks right.
      const packedR = BTN.NONE * 9 + DIR.R
      for (let f = 0; f < FRAME_SKIP; f++) stepPacked(mirror, f < lag ? 0 : packedR, 0)
      expect(sim[0]!.fighters[0].pos.x).toBe(mirror.fighters[0].pos.x)
      expect(sim[0]!.frame).toBe(mirror.frame)
      // A block later the previous block's input is the lagged one: seat 0 now proposes Left, but still walks right for `lag` frames.
      env.step(new Int32Array([DIR.L, BTN.NONE, 0, 0]))
      const packedL = BTN.NONE * 9 + DIR.L
      for (let f = 0; f < FRAME_SKIP; f++) stepPacked(mirror, f < lag ? packedR : packedL, 0)
      expect(sim[0]!.fighters[0].pos.x).toBe(mirror.fighters[0].pos.x)
    })
  }

  test('a scripted bot is a human at the keyboard: its input is not lagged', () => {
    const env = make(1, 'hard')
    env.reset([2000])
    const sim = (env as unknown as { states: FighterState[] }).states
    // seat 1 is the pokeloop-free rushdown bot (-2): its first block must equal a hand-stepped block with no lag.
    const mirror = createState(0)
    copyState(mirror, sim[0]!)
    const action = createBot('rushdown', 2000 + 104729 * 2 + 1).act(buildObs(mirror, 1))
    const dir = action % N_DIRS
    const packed = Math.floor(action / N_DIRS) * N_DIRS + viewDirToScreen(dir, 1)
    for (let frame = 0; frame < FRAME_SKIP; frame++) stepPacked(mirror, 0, packed)
    env.step(new Int32Array([0, 0, -2, 0]))
    expect(sim[0]!.fighters[1].pos.x).toBe(mirror.fighters[1].pos.x)
  })
})
