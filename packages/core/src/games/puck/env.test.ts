import { describe, expect, test } from 'bun:test'
import { loadEnvFactory } from '../../bridge/env-host'
import { LEVEL_LIMITS } from '../../limiter'
import { makeRng } from '../../rng'
import type { Level } from '../../product'
import { BIN_X, BIN_Y, FRAME_SKIP, OBS_FEATURES, PUCK_BOT_KINDS, VIEW_FEATURES, createEnv, playBotMatch, writeSeatView, type PuckEnv } from './env'
import { LEVEL_MALLET, PUCK_TPS } from './constants'
import type { PuckState } from './state'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

function make(n: number, level?: Level, extra: Record<string, unknown> = {}): PuckEnv {
  return createEnv!({ n, seed: 0, level, ...extra } as never) as PuckEnv
}
/** Actions for every env: both seats the same (x bin, y bin). */
function same(n: number, x: number, y: number): Int32Array {
  const a = new Int32Array(n * 4)
  for (let i = 0; i < n * 2; i++) {
    a[i * 2] = x
    a[i * 2 + 1] = y
  }
  return a
}

describe('puck env shape', () => {
  test('constants and bot order are the interface', () => {
    expect(FRAME_SKIP).toBe(2)
    expect([BIN_X, BIN_Y]).toEqual([11, 9])
    expect([...PUCK_BOT_KINDS]).toEqual(['random', 'striker', 'goalie', 'banker', 'shadow'])
    const e = make(3)
    expect(e.obsShape).toEqual([2, OBS_FEATURES])
    expect(e.actionDims).toBe(2)
    expect(e.reset([1, 2, 3]).length).toBe(3 * 2 * OBS_FEATURES)
  })

  test('loads over the bridge host and rejects bad input', async () => {
    const f = await loadEnvFactory('puck')
    const e = f({ n: 2, seed: 0, level: 'hard' })
    expect(e.version).toMatch(/^puck-env-/)
    expect(() => f({ n: 1, seed: 0, level: 'nope' })).toThrow()
    const m = make(1, 'easy')
    m.reset([1])
    expect(() => m.step(new Int32Array(3))).toThrow()
    expect(() => m.step(same(1, 11, 0))).toThrow(RangeError)
    expect(() => m.step(same(1, 0, 9))).toThrow(RangeError)
    const bad = same(1, 0, 0)
    bad[0] = -1 - 6 - 1
    expect(() => m.step(bad)).toThrow(RangeError)
  })
})

describe('delayed view, undelayed hands', () => {
  for (const level of LEVELS) {
    test(`${level}: puck and opponent are exactly delayFrames late, own mallet is live`, () => {
      const delay = LEVEL_LIMITS.puck[level].delayFrames
      const env = make(1, level)
      const views: Float32Array[][] = [[], []]
      const frames: number[] = []
      env.onFrame = (_i, s) => {
        frames.push(s.frame)
        for (const k of [0, 1] as const) {
          const v = new Float32Array(VIEW_FEATURES)
          writeSeatView(s, k, v, 0)
          views[k]![s.frame] = v
        }
      }
      let obs = env.reset([5])
      const rng = makeRng(9)
      const checked: number[] = []
      for (let d = 0; d < 80; d++) {
        const frame = d * FRAME_SKIP
        expect(frames[frames.length - 1]).toBe(frame)
        for (const k of [0, 1] as const) {
          const base = k * OBS_FEATURES
          const want = views[k]![Math.max(0, frame - delay)]!
          expect(Array.from(obs.slice(base, base + VIEW_FEATURES))).toEqual(Array.from(want))
          // The own block is the live mallet, not the delayed one.
          const m = env.stateOf(0).m[k]!
          expect(obs[base + VIEW_FEATURES]).toBeCloseTo(k === 0 ? m.x * 2 - 1 : (1 - m.x) * 2 - 1, 6)
        }
        checked.push(frame)
        const a = new Int32Array(4)
        a[0] = rng.int(BIN_X); a[1] = rng.int(BIN_Y); a[2] = rng.int(BIN_X); a[3] = rng.int(BIN_Y)
        const out = env.step(a)
        if (out.done[0]) break
        obs = out.obs
      }
      expect(checked.length).toBeGreaterThan(60)
    })
  }

  test('a change in the live puck the delayed view has not reached leaves the observation unchanged', () => {
    const run = (nudge: boolean): number[] => {
      const env = make(1, 'easy')
      let obs = env.reset([11])
      for (let d = 0; d < 10; d++) obs = env.step(same(1, 5, 4)).obs
      if (nudge) {
        const s = env.stateOf(0)
        s.px = 0.9
        s.py = 1.7
        s.pvx = 2
      }
      // The next decision still shows a frame at or before the nudge (18 frames of delay).
      obs = env.step(same(1, 5, 4)).obs
      return Array.from(obs.slice(0, VIEW_FEATURES))
    }
    expect(run(true)).toEqual(run(false))
  })
})

describe('mallet limits', () => {
  for (const level of LEVELS) {
    test(`${level}: speed and acceleration never exceed the level's caps, both seats`, () => {
      const lim = LEVEL_MALLET[level]
      const env = make(2, level)
      const prev = new Float64Array(4)
      let maxSp = 0
      let maxGain = 0
      env.onFrame = (i, s) => {
        for (const k of [0, 1] as const) {
          const m = s.m[k]!
          const sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy)
          if (s.frame > 0) maxGain = Math.max(maxGain, (sp - prev[i * 2 + k]!) * PUCK_TPS)
          prev[i * 2 + k] = sp
          maxSp = Math.max(maxSp, sp)
          expect(m.speed).toBe(lim.speed)
          expect(m.accel).toBe(lim.accel)
        }
      }
      env.reset([3, 4])
      const rng = makeRng(2)
      for (let d = 0; d < 400; d++) {
        const a = new Int32Array(8)
        for (let j = 0; j < 4; j++) { a[j * 2] = rng.int(BIN_X); a[j * 2 + 1] = rng.int(BIN_Y) }
        env.step(a)
      }
      expect(maxSp).toBeLessThanOrEqual(lim.speed + 1e-9)
      expect(maxSp).toBeGreaterThan(lim.speed * 0.5)
      // Speed can rise by at most accel per second (a tiny margin for the per-substep rounding).
      expect(maxGain).toBeLessThanOrEqual(lim.accel * 1.001)
    })
  }

  test('no level: the rule speed, no target noise', () => {
    const env = make(1)
    env.reset([1])
    expect(env.stateOf(0).m[0]!.speed).toBe(6)
    env.step(same(1, 5, 4))
    expect(env.stateOf(0).m[0]!.tx).toBeCloseTo(0.5, 2)
  })
})

describe('target noise', () => {
  const sdAt = (level: Level): number => {
    const n = 200
    const env = make(n, level)
    env.reset(Array.from({ length: n }, (_, i) => 100 + i))
    env.step(same(n, 5, 4))
    let sum = 0
    let sum2 = 0
    for (let i = 0; i < n; i++) {
      const e = env.stateOf(i).m[0]!.tx - 0.5
      sum += e
      sum2 += e * e
    }
    return Math.sqrt(sum2 / n - (sum / n) ** 2)
  }
  test('is drawn from the env rng: same seeds give the same targets, and the spread follows the level', () => {
    expect(sdAt('easy')).toBe(sdAt('easy'))
    const sd = LEVELS.map(sdAt)
    LEVELS.forEach((l, k) => {
      const want = LEVEL_MALLET[l].targetNoise
      expect(sd[k]!).toBeGreaterThan(want * 0.6)
      expect(sd[k]!).toBeLessThan(want * 1.5)
    })
  })
  test('a whole run is reproducible from the seed', () => {
    const run = (seed: number): string => {
      const env = make(2, 'hard')
      env.reset([seed, seed + 1])
      const rng = makeRng(77)
      let h = ''
      for (let d = 0; d < 300; d++) {
        const a = new Int32Array(8)
        for (let j = 0; j < 4; j++) { a[j * 2] = rng.int(BIN_X); a[j * 2 + 1] = rng.int(BIN_Y) }
        const out = env.step(a)
        h += Array.from(out.reward).join(',') + ';'
      }
      return h + env.hashOf(0) + env.hashOf(1)
    }
    expect(run(40)).toBe(run(40))
    expect(run(40)).not.toBe(run(41))
  })
})

describe('bot sentinels', () => {
  test('-1 - index plays that bot; the y head is ignored; each kind plays differently', () => {
    const hashes: string[] = []
    PUCK_BOT_KINDS.forEach((_, idx) => {
      const run = (yHead: number): string => {
        const env = make(1, 'hard')
        env.reset([21])
        for (let d = 0; d < 150; d++) {
          const a = same(1, 5, 4)
          a[0] = -1 - idx
          a[1] = yHead
          env.step(a)
        }
        return env.hashOf(0)
      }
      expect(run(0)).toBe(run(8))
      hashes.push(run(0))
    })
    expect(new Set(hashes.map((h) => h)).size).toBe(PUCK_BOT_KINDS.length)
  })

  test('bots below Champion see the delayed game, at Champion the live game', () => {
    for (const [level, delay] of [['easy', 18], ['hard', 12], ['champion', 0]] as const) {
      const env = make(1, level)
      env.reset([8])
      for (let d = 0; d < 40; d++) {
        const a = same(1, 5, 4)
        a[0] = -2 // striker
        env.step(a)
        const f = env.stateOf(0).frame
        // After the step the bot acted at the decision before it: frame - FRAME_SKIP.
        expect(env.botViewFrame[0]).toBe(Math.max(0, f - FRAME_SKIP - delay))
      }
    }
  })
})

describe('episodes', () => {
  test('ends at first to 7 with the winner named, then auto-resets on the next seed', () => {
    const env = make(1, 'champion', { trainCapFrames: 36_000 })
    let obs = env.reset([30])
    let done = false
    for (let d = 0; d < 20000 && !done; d++) {
      const a = same(1, 5, 4)
      a[0] = -2 // striker
      a[2] = -1 // random
      const out = env.step(a)
      obs = out.obs
      if (out.done[0]) {
        done = true
        const info = out.infos[0] as { winner: number | null; score: [number, number]; reason: string }
        expect(Math.max(...info.score)).toBeGreaterThanOrEqual(7)
        expect(info.reason).toBe('goals')
        expect(info.winner).toBe(info.score[0] > info.score[1] ? 0 : 1)
      }
    }
    expect(done).toBe(true)
    // New episode: frame 0 again.
    expect(env.stateOf(0).frame).toBe(0)
    expect(obs.length).toBe(2 * OBS_FEATURES)
  })

  test('the training cap ends an episode with the leader named (default 7200, option trainCapFrames)', () => {
    const env = make(1, 'easy', { trainCapFrames: 120 })
    env.reset([2])
    let info: { frames: number; reason: string } | undefined
    for (let d = 0; d < 100 && !info; d++) {
      const out = env.step(same(1, 5, 4))
      if (out.done[0]) info = out.infos[0] as never
    }
    expect(info?.frames).toBe(120)
    expect(info?.reason).toBe('cap')
    const big = make(1, 'easy')
    big.reset([2])
    let longest = 0
    for (let d = 0; d < 4000; d++) {
      const out = big.step(same(1, 5, 4))
      if (out.done[0]) {
        longest = (out.infos[0] as { frames: number }).frames
        break
      }
    }
    expect(longest).toBeGreaterThan(0)
    expect(longest).toBeLessThanOrEqual(7200)
  }, 30_000)
})

describe('reward', () => {
  test('per episode it sums to goals for minus goals against minus half a foul conceded', () => {
    const env = make(4, 'hard')
    env.reset([1, 2, 3, 4])
    const sum = [0, 0, 0, 0]
    let episodes = 0
    for (let d = 0; d < 6000 && episodes < 8; d++) {
      const a = same(4, 5, 4)
      for (let i = 0; i < 4; i++) {
        a[i * 4] = -1 - (i % 3) // random, striker, goalie
        a[i * 4 + 2] = -1 - ((i + 1) % 5)
      }
      const out = env.step(a)
      for (let i = 0; i < 4; i++) {
        sum[i] += out.reward[i]!
        if (out.done[i]) {
          const info = out.infos.find((x) => (x as { env: number }).env === i) as { score: [number, number]; fouls: [number, number] }
          expect(sum[i]).toBeCloseTo(info.score[0] - info.score[1] - 0.5 * info.fouls[0], 4)
          sum[i] = 0
          episodes++
        }
      }
    }
    expect(episodes).toBeGreaterThanOrEqual(4)
  })
})

describe('playBotMatch', () => {
  test('is deterministic per seed', () => {
    const a = playBotMatch(5, 'striker', 'goalie', 'hard')
    const b = playBotMatch(5, 'striker', 'goalie', 'hard')
    expect(a).toEqual(b)
    expect(playBotMatch(6, 'striker', 'goalie', 'hard').hash).not.toBe(a.hash)
  })
})

// Typecheck helper so the state type stays exported for tests.
export type _S = PuckState

describe('goal-direction shaping (training option)', () => {
  /** Seat 0 plays the striker bot, seat 1 the goalie bot; returns the per-decision reward of env 0. */
  function rewards(extra: Record<string, unknown>, decisions: number): number[] {
    const e = make(1, 'champion', extra)
    e.reset([5])
    const a = new Int32Array(4)
    a[0] = -1 - PUCK_BOT_KINDS.indexOf('striker')
    a[2] = -1 - PUCK_BOT_KINDS.indexOf('goalie')
    const out: number[] = []
    for (let i = 0; i < decisions; i++) out.push(e.step(a).reward[0]!)
    return out
  }

  test('adds exactly the shaping value to some decisions and nothing to a run without the option', () => {
    const plain = rewards({}, 600)
    const shaped = rewards({ goalShaping: 0.002 }, 600)
    const diffs = shaped.map((r, i) => Math.round((r - plain[i]!) * 1e6) / 1e6)
    expect(diffs.every((d) => d === 0 || d === 0.002)).toBe(true)
    expect(diffs.some((d) => d === 0.002)).toBe(true)
    expect(rewards({ goalShaping: 0 }, 600)).toEqual(plain)
  })
})

describe('champion bot delay is a training-only option', () => {
  /** Frames the bot on seat 0 lags its own env's live frame, over a rollout. */
  function maxLag(extra: Record<string, unknown>): number {
    const e = make(1, 'champion', extra)
    e.reset([3])
    const a = new Int32Array(4)
    a[0] = -1 - PUCK_BOT_KINDS.indexOf('striker')
    a[2] = -1 - PUCK_BOT_KINDS.indexOf('goalie')
    let lag = 0
    for (let i = 0; i < 200; i++) {
      const frame = e.stateOf(0).frame
      e.step(a)
      lag = Math.max(lag, frame - e.botViewFrame[0]!)
    }
    return lag
  }

  test('with no option Champion bots see the live game; with 9 they lag 9 frames', () => {
    expect(maxLag({})).toBe(0)
    expect(maxLag({ championBotDelay: 9 })).toBeGreaterThanOrEqual(9)
  })
})
