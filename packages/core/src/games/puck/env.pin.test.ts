import { describe, expect, test } from 'bun:test'
import type { Level } from '../../product'
import { makeRng } from '../../rng'
import { ALL_BOT_KINDS } from './bots'
import { createEnv, type PuckEnv } from './env'

// A pinned fingerprint of the training env's behaviour. Sable's live training reloads env.ts, so any refactor of
// the hands (limiter, noise, bot delay) must leave these hashes unchanged. Do not re-pin to make a refactor pass. Repinned once, for the puck-2 pace change (a deliberate sim change: cap 4.0, drag 0.92 per second), and the medium row once more for Marlow's aim noise 0.035 to 0.040 (puck-2 pace).

function fnv(h: number, v: number): number {
  return Math.imul((h ^ v) >>> 0, 16777619) >>> 0
}

function fingerprint(level: Level | undefined, extra: Record<string, unknown>, seed: number, decisions: number): string {
  const env = createEnv!({ n: 2, seed, level, trainCapFrames: 900, ...extra } as never) as PuckEnv
  const rng = makeRng(seed ^ 0x5bd1e995)
  let h = 2166136261
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  const eat = (o: Float32Array): void => {
    for (let i = 0; i < o.length; i++) {
      f32[0] = o[i]!
      h = fnv(h, u32[0]!)
    }
  }
  eat(env.reset([seed, seed + 1]))
  const a = new Int32Array(8)
  for (let d = 0; d < decisions; d++) {
    for (let k = 0; k < 4; k++) {
      const phase = Math.floor(d / 40) + k
      // Seats take turns between bot sentinels (pip included) and raw bin actions.
      if (phase % 3 === 0) {
        a[k * 2] = -1 - (phase % ALL_BOT_KINDS.length)
        a[k * 2 + 1] = 0
      } else {
        a[k * 2] = Math.floor(rng.float() * 11)
        a[k * 2 + 1] = Math.floor(rng.float() * 9)
      }
    }
    const out = env.step(a)
    eat(out.obs)
    for (let i = 0; i < 2; i++) for (const ch of env.hashOf(i)) h = fnv(h, ch.charCodeAt(0))
    for (const inf of out.infos) h = fnv(h, (inf as { frames: number }).frames)
  }
  return h.toString(16)
}

describe('env rollout fingerprint', () => {
  const cases: Array<[Level | undefined, Record<string, unknown>, number]> = [
    ['easy', {}, 11],
    ['medium', {}, 12],
    ['hard', {}, 13],
    ['champion', {}, 14],
    ['champion', { championBotDelay: 9 }, 15],
    [undefined, {}, 16],
  ]
  const PINNED: Record<string, string> = {
    'easy|{}|11': '8579e5c8',
    'medium|{}|12': '1e2467d9',
    'hard|{}|13': 'ffd85f24',
    'champion|{}|14': 'b6822e07',
    'champion|{"championBotDelay":9}|15': '4a0fcb5c',
    'undefined|{}|16': '5b573b21',
  }
  for (const [level, extra, seed] of cases) {
    test(`level ${level ?? 'none'} ${JSON.stringify(extra)} seed ${seed}`, () => {
      const key = `${level}|${JSON.stringify(extra)}|${seed}`
      const got = fingerprint(level, extra, seed, 700)
      expect({ key, got }).toEqual({ key, got: PINNED[key] ?? 'UNSET' })
    })
  }
})
