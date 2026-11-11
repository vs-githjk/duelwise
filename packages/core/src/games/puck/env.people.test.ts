import { describe, expect, test } from 'bun:test'
import { RULE_MALLET_SPEED, DEFAULT_ACCEL } from './constants'
import { createEnv, type PuckEnv } from './env'
import { PEOPLE_BOT_KINDS, PEOPLE_PROFILES, peopleHands, peopleSentinel } from './seat-hands'

// People sentinels: a seat the learner's opponent bot occupies can play on a person's hands (rule mallet, profile delay, noise and hold).

const run = (level: 'medium' | 'champion' | undefined, sentinel: number, frames = 40) => {
  const env = createEnv!({ n: 1, seed: 3, level } as never) as PuckEnv
  env.reset([11])
  let peakSpeed = 0
  let lag = 0
  for (let t = 0; t < frames; t++) {
    env.step(Int32Array.from([5, 5, sentinel, 0]))
    const s = env.stateOf(0)
    peakSpeed = Math.max(peakSpeed, Math.hypot(s.m[1]!.vx, s.m[1]!.vy))
    lag = Math.max(lag, s.frame - env.botViewFrame[1]!)
  }
  return { env, peakSpeed, lag }
}

describe('puck env people sentinels', () => {
  test('profiles: delay and noise fall from beginner to strong, the rule mallet for all', () => {
    const [b, a, s] = PEOPLE_PROFILES.map(peopleHands)
    expect(b!.delayFrames).toBeGreaterThan(a!.delayFrames)
    expect(a!.delayFrames).toBeGreaterThan(s!.delayFrames)
    expect(b!.noiseSd).toBeGreaterThan(a!.noiseSd)
    expect(a!.noiseSd).toBeGreaterThan(s!.noiseSd)
    expect(s!.delayFrames).toBe(12)
  })

  test('the seat takes the rule mallet and the profile delay, and the bot sees its delayed view', () => {
    const { env, lag } = run('medium', peopleSentinel('mouse', 'average'))
    const m = env.stateOf(0).m[1]!
    expect(m.speed).toBe(RULE_MALLET_SPEED)
    expect(m.accel).toBe(DEFAULT_ACCEL)
    expect(lag).toBeGreaterThanOrEqual(peopleHands('average').delayFrames)
    // The seat without a sentinel keeps the level's mallet.
    expect(env.stateOf(0).m[0]!.speed).toBeLessThan(RULE_MALLET_SPEED)
  })

  test('a plain bot sentinel is untouched (level hands, level delay)', () => {
    const { env } = run('medium', -1 - 1)
    expect(env.stateOf(0).m[1]!.speed).toBeLessThan(RULE_MALLET_SPEED)
  })

  test('same seed, same rollout', () => {
    const a = run('medium', peopleSentinel('striker', 'strong'), 80).env.hashOf(0)
    const b = run('medium', peopleSentinel('striker', 'strong'), 80).env.hashOf(0)
    expect(a).toBe(b)
  })

  test('every kind and profile is a valid sentinel; a bad one throws', () => {
    for (const p of PEOPLE_PROFILES) for (const k of PEOPLE_BOT_KINDS) run('medium', peopleSentinel(k, p), 4)
    expect(() => run('medium', -1 - (16 * 5 + 0), 2)).toThrow()
    expect(() => run('medium', -1 - (16 * 1 + 9), 2)).toThrow()
  })
})
