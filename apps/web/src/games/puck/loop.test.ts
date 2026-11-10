import { describe, expect, test } from 'bun:test'
import { hashPuckState } from '@duelwise/core/src/games/puck/state'
import { playBotMatch } from '@duelwise/core/src/games/puck/env'
import { observe } from '@duelwise/core/src/games/puck/core'
import { GRID, NO_INPUT, PHASE } from '@duelwise/core/src/games/puck/constants'
import { SeatHands, botDelayFor } from '@duelwise/core/src/games/puck/seat-hands'
import { DelayedStates } from '@duelwise/core/src/limiter'
import { blankState, copyState, type PuckState } from '@duelwise/core/src/games/puck/state'
import type { Level } from '@duelwise/core/src/product'
import { FixedLoop, PuckMatch } from './loop'

/** Drives a match for `seconds` of wall time with a draw every 1000/hz ms. */
function play(hz: number, seconds: number): { ticks: number; hash: string } {
  const m = new PuckMatch(7, 'easy')
  const loop = new FixedLoop()
  const n = Math.round(seconds * hz)
  for (let i = 0; i <= n; i++) {
    loop.advance(1000 + (i * 1000) / hz, () => {
      const f = m.s.frame
      // A scripted hand: sweeps across the half, a pure function of the tick index.
      m.tick(((Math.sin(f / 25) * 0.4 + 0.5) * (GRID - 1) | 0) + GRID * (((Math.sin(f / 31) * 0.3 + 0.4) * (GRID - 1)) | 0))
    })
  }
  return { ticks: m.s.frame, hash: hashPuckState(m.s) }
}

describe('fixed step loop', () => {
  test('the same state at 30, 60 and 120 Hz draw rates', () => {
    const a = play(30, 20)
    const b = play(60, 20)
    const c = play(120, 20)
    expect(a.ticks).toBe(1200)
    expect(b.ticks).toBe(1200)
    expect(c.ticks).toBe(1200)
    expect(b.hash).toBe(a.hash)
    expect(c.hash).toBe(a.hash)
  })
  test('a 144 Hz draw and a ragged one never skip or add a tick', () => {
    const loop = new FixedLoop()
    let ticks = 0
    let t = 5000
    loop.advance(t, () => ticks++)
    for (let i = 0; i < 1440; i++) {
      t += 1000 / 144 + (i % 3 === 0 ? 0.4 : -0.2)
      loop.advance(t, () => ticks++)
    }
    expect(Math.abs(ticks - 600)).toBeLessThanOrEqual(1)
  })
  test('a hidden tab resumes with no burst of frames', () => {
    const loop = new FixedLoop()
    let ticks = 0
    loop.advance(1000, () => ticks++)
    loop.advance(1016.7, () => ticks++)
    expect(ticks).toBe(1)
    loop.pause()
    loop.advance(61_000, () => ticks++)
    expect(ticks).toBe(1)
    loop.advance(61_016.7, () => ticks++)
    expect(ticks).toBe(2)
  })
  test('a long stall without pause() also drops the backlog instead of bursting', () => {
    const loop = new FixedLoop()
    let ticks = 0
    loop.advance(0, () => ticks++)
    loop.advance(16.7, () => ticks++)
    loop.advance(30_000, () => ticks++)
    expect(ticks).toBeLessThanOrEqual(2)
  })
  test('alpha is the fraction of the next tick, for the interpolated draw', () => {
    const loop = new FixedLoop()
    loop.advance(0, () => {})
    loop.advance(25, () => {})
    expect(loop.alpha).toBeCloseTo((25 - 1000 / 60) / (1000 / 60), 6)
  })
})

describe('match against Pip', () => {
  test('a match with an idle human ends, Pip wins, and the record is deterministic', () => {
    const run = () => {
      const m = new PuckMatch(3, 'easy')
      for (let i = 0; i < 40_000 && !m.over; i++) m.tick(-1)
      return m
    }
    const a = run()
    const b = run()
    expect(a.over).toBe(true)
    expect(a.s.winner).toBe(1)
    expect(hashPuckState(a.s)).toBe(hashPuckState(b.s))
  })
})

/** Seat 0 played exactly as the training env plays a scripted seat 0: same delay rule, same hands. */
function pageMatchLikeEnv(seed: number, level: Level, kind0: 'striker' | 'goalie' | 'random'): PuckMatch {
  const m = new PuckMatch(seed, level, 'pip', true, true)
  const hands = new SeatHands(seed, 0, level)
  const bot = hands.bot(kind0)
  const hist = new DelayedStates<PuckState>(botDelayFor(level), blankState, copyState)
  hist.record(0, m.s)
  let code = NO_INPUT
  for (let i = 0; i < 40_000 && !m.over; i++) {
    const s = m.s
    if (s.frame % 2 === 0 && s.phase !== PHASE.OVER) {
      const view = observe(hist.view(s.frame).state, 0)
      view.me = observe(s, 0).me
      const t = bot.act(view)
      code = hands.act(t[0], t[1], s.frame)
    }
    m.tick(code)
    code = NO_INPUT
    hist.record(m.s.frame, m.s)
  }
  return m
}

describe('page Pip plays the same hands as the training env', () => {
  test('about ten seeds at Easy end with the same state hash as playBotMatch', () => {
    for (let seed = 1000; seed < 1010; seed++) {
      const m = pageMatchLikeEnv(seed, 'easy', 'striker')
      const ref = playBotMatch(seed, 'striker', 'pip', 'easy')
      expect(m.over).toBe(true)
      expect(hashPuckState(m.s)).toBe(ref.hash)
    }
  })
  test('Champion gives Pip a live view, like env bots, and still matches', () => {
    for (let seed = 2000; seed < 2004; seed++) {
      expect(hashPuckState(pageMatchLikeEnv(seed, 'champion', 'goalie').s)).toBe(playBotMatch(seed, 'goalie', 'pip', 'champion').hash)
    }
  })
})

describe('fixed step loop hold (a browser agent\'s answer is overdue)', () => {
  test('a hold stops the ticks, keeps the time owed, and the next call catches up without a burst past maxSteps', () => {
    const loop = new FixedLoop()
    let ticks = 0
    loop.advance(1000, () => {})
    // 50 ms is three ticks owed; the hold stops the second one.
    const n1 = loop.advance(1050, () => ticks++, () => ticks >= 1)
    expect(n1).toBe(1)
    expect(ticks).toBe(1)
    const n2 = loop.advance(1050, () => ticks++)
    expect(n2).toBeGreaterThanOrEqual(2)
    expect(n2).toBeLessThanOrEqual(5)
    expect(loop.advance(1050, () => ticks++, () => true)).toBe(0)
  })
})
