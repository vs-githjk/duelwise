import { describe, expect, test } from 'bun:test'
import { observe } from './core'
import { createState } from './state'
import { ALL_BOT_KINDS, createBot, type PuckBotKind } from './bots'
import { PUCK_BOT_KINDS, playBotMatch } from './env'
import { makeRng } from '../../rng'

function tally(a: PuckBotKind, b: PuckBotKind, games: number, seed0: number, level: 'easy' | 'champion' = 'champion') {
  let aWins = 0
  let bWins = 0
  let draws = 0
  for (let i = 0; i < games; i++) {
    const swap = i % 2 === 1
    const m = swap ? playBotMatch(seed0 + i, b, a, level) : playBotMatch(seed0 + i, a, b, level)
    if (m.winner === null) draws++
    else if ((m.winner === 0) !== swap) aWins++
    else bWins++
  }
  return { aWins, bWins, draws }
}

describe('scripted puck bots', () => {
  test('the five sentinel kinds come first, in the league order; pip follows; the measurement-only mouse is not an env sentinel', () => {
    expect([...ALL_BOT_KINDS]).toEqual([...PUCK_BOT_KINDS, 'pip'])
    expect(ALL_BOT_KINDS).not.toContain('mouse')
  })

  test('every bot answers with a point inside its own half, on random states', () => {
    const rng = makeRng(4)
    for (const kind of [...ALL_BOT_KINDS, 'mouse' as const]) {
      const bot = createBot(kind, 3)
      for (let t = 0; t < 400; t++) {
        const s = createState(t)
        s.px = rng.float(); s.py = rng.float() * 2
        s.pvx = (rng.float() - 0.5) * 8; s.pvy = (rng.float() - 0.5) * 8
        s.m[0].x = rng.float(); s.m[0].y = rng.float() * 0.9
        s.m[1].x = rng.float(); s.m[1].y = 1.1 + rng.float() * 0.9
        const [x, y] = bot.act(observe(s, (t % 2) as 0 | 1))
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(1)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(1)
      }
    }
  })

  test('a bot is a pure function of its seed and what it sees', () => {
    for (const kind of [...ALL_BOT_KINDS, 'mouse' as const]) {
      const run = (seed: number): string => {
        const a = createBot(kind, seed)
        const s = createState(7)
        let h = ''
        for (let t = 0; t < 60; t++) {
          s.px = (t % 10) / 10; s.py = 0.3 + (t % 7) / 5
          s.pvx = (t % 5) - 2; s.pvy = (t % 3) - 1
          h += a.act(observe(s, 0)).join(',') + ';'
        }
        return h
      }
      expect(run(1)).toBe(run(1))
    }
    // Only random draws from its seed.
    const one = (seed: number) => createBot('random', seed).act(observe(createState(1), 0)).join()
    expect(one(1)).not.toBe(one(2))
  })

  test('whole matches are deterministic per seed', () => {
    expect(playBotMatch(12, 'banker', 'shadow', 'champion')).toEqual(playBotMatch(12, 'banker', 'shadow', 'champion'))
  })

  for (const kind of ['striker', 'banker', 'shadow'] as const) {
    test(`${kind} beats random in at least 45 of 50 games`, () => {
      const t = tally(kind, 'random', 50, 1000)
      expect(t.aWins).toBeGreaterThanOrEqual(45)
    }, 60_000)
  }

  test('goalie beats random (it defends and clears)', () => {
    const t = tally('goalie', 'random', 50, 2000)
    expect(t.aWins).toBeGreaterThanOrEqual(45)
  }, 60_000)

  test('pip beats random in at least 40 of 50 games at Easy limits', () => {
    const t = tally('pip', 'random', 50, 3000, 'easy')
    expect(t.aWins).toBeGreaterThanOrEqual(40)
  }, 60_000)

  test('two defenders still end every match at or under the hard cap (a draw is allowed there)', () => {
    for (let i = 0; i < 4; i++) {
      const m = playBotMatch(5000 + i, 'goalie', 'shadow', 'champion')
      expect(m.frames).toBeLessThanOrEqual(36_000)
      expect(['goals', 'time', 'sudden', 'draw']).toContain(m.reason)
    }
  }, 60_000)

  test('mouse winds up behind a slow puck on the line to the goal, then drives through it', () => {
    const s = createState(1)
    s.px = 0.5; s.py = 0.5; s.pvx = 0; s.pvy = 0
    s.m[0].x = 0.9; s.m[0].y = 0.2
    s.m[1].x = 0.5; s.m[1].y = 1.8
    const [x, y] = createBot('mouse', 1).act(observe(s, 0))
    // Not on the puck yet: it lines up behind it (nearer its own goal than the puck is).
    expect(y).toBeLessThan(0.5)
    expect(Math.abs(x - 0.5)).toBeLessThan(0.15)
    // Once it is behind the puck on the line, the target is through the puck, past it toward the goal.
    s.m[0].x = 0.5
    s.m[0].y = 0.3
    const t = createBot('mouse', 1).act(observe(s, 0))
    expect(t[1]).toBeGreaterThan(0.5)
  })

  test('mouse meets a fast shot where it will arrive, in front of its goal', () => {
    const s = createState(1)
    s.px = 0.7; s.py = 0.9; s.pvx = -0.6; s.pvy = -3.5
    s.m[0].x = 0.5; s.m[0].y = 0.4
    const [x, y] = createBot('mouse', 1).act(observe(s, 0))
    expect(y).toBeLessThan(0.3)
    expect(Math.abs(x - (0.7 - 0.6 * ((0.22 - 0.9) / -3.5)))).toBeLessThan(0.02)
  })

})
