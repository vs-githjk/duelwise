import { describe, expect, test } from 'bun:test'
import { observe } from '@duelwise/core/src/games/puck/core'
import { createState } from '@duelwise/core/src/games/puck/state'
import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { wilson } from '../measure/ladder'
import { playGame } from '../measure/harness'
import { createBotAgent, createGameAgent, puckCoreAt } from './pip'

const DELAY = LEVEL_LIMITS.puck.easy.delayFrames

/** Pip against random, both at Easy limits, through the harness's playGame; returns Pip's points per seat. */
async function pipVsRandom(games: number, seed0: number): Promise<[number, number]> {
  const core = puckCoreAt('easy', 'easy')
  const points: [number, number] = [0, 0]
  for (let i = 0; i < games; i++) {
    const pipSeat = (i % 2) as 0 | 1
    const pip = await createGameAgent('easy', { seat: pipSeat })
    const rnd = await createBotAgent('random', 'easy', { seat: (1 - pipSeat) as 0 | 1 })
    const { result } = await playGame(core, pipSeat === 0 ? [pip, rnd] : [rnd, pip], seed0 + i, 40_000)
    points[pipSeat] += result === null || result.winner === null ? 0.5 : result.winner === pipSeat ? 1 : 0
    pip.dispose()
    rnd.dispose()
  }
  return points
}

describe('Pip, the scripted Easy opponent', () => {
  test('beats random at Easy limits with a Wilson lower bound over 0.5 from each seat, 200 games', async () => {
    const per = await pipVsRandom(200, 40_000)
    for (const seat of [0, 1] as const) {
      expect(wilson(per[seat], 100)[0]).toBeGreaterThan(0.5)
    }
  }, 120_000)

  test('only Easy is scripted', async () => {
    await expect(createGameAgent('hard', { seat: 1 })).rejects.toThrow()
  })

  test('its answer never depends on the score', async () => {
    const run = async (score: [number, number]) => {
      const agent = await createGameAgent('easy', { seat: 0 })
      agent.reset(5)
      const s = createState(5)
      s.px = 0.7; s.py = 0.5; s.pvx = 0.2; s.pvy = 0.1
      const out: number[][] = []
      for (let f = 0; f < 60; f++) {
        s.frame = f
        s.score[0] = score[0]; s.score[1] = score[1]
        out.push(await agent.act(observe(s, 0)))
      }
      return out
    }
    const base = await run([0, 0])
    expect(await run([6, 6])).toEqual(base)
    expect(await run([0, 5])).toEqual(base)
  })

  test('it reads the puck as it was 300 ms ago', async () => {
    // The puck sits far away, then at frame 100 a fast shot appears. Until frame 100 + DELAY the agent cannot have seen it.
    const run = async (shotAt: number) => {
      const agent = await createGameAgent('easy', { seat: 0 })
      agent.reset(9)
      const s = createState(9)
      const codes: number[] = []
      for (let f = 0; f < 160; f++) {
        s.frame = f
        s.px = 0.9; s.py = 1.6; s.pvx = 0; s.pvy = 0
        if (f >= shotAt) { s.px = 0.3; s.py = 0.6; s.pvx = -1.4; s.pvy = -3 }
        codes.push((await agent.act(observe(s, 0)))[0]!)
      }
      return codes
    }
    const withShot = await run(100)
    const never = await run(10_000)
    expect(withShot.slice(0, 100 + DELAY)).toEqual(never.slice(0, 100 + DELAY))
    // After the delay it can answer the shot.
    expect(withShot.slice(100 + DELAY).some((c, i) => c !== never[100 + DELAY + i])).toBe(true)
  })

  test('between decisions it answers "no input" (the target is held)', async () => {
    const agent = await createGameAgent('easy', { seat: 1 })
    agent.reset(3)
    const s = createState(3)
    const codes: number[] = []
    for (let f = 0; f < 6; f++) {
      s.frame = f
      codes.push((await agent.act(observe(s, 1)))[0]!)
    }
    expect(codes[1]).toBe(NO_INPUT)
    expect(codes[3]).toBe(NO_INPUT)
    expect(codes[0]).not.toBe(NO_INPUT)
  })

  test('a run is a pure function of the seed', async () => {
    const a = await pipVsRandom(2, 77)
    const b = await pipVsRandom(2, 77)
    expect(a).toEqual(b)
  }, 60_000)
})
