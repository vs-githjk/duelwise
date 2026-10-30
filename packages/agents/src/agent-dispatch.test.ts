import { describe, expect, test } from 'bun:test'
import { createCounterGame, createDriftGame } from '@duelwise/core/src/testing/counter-game'
import { createGameAgent } from './agent-dispatch'
import { createStubAgent } from './stub-agent'
import type { GameId, Level } from '@duelwise/core/src/product'

// Dispatch is tested only for shape, so lanes can replace a game's stub without editing this file (R9).
// Stub behaviour is tested on createStubAgent directly.
const GAMES: GameId[] = ['chess', 'four', 'holdem', 'word', 'fighter', 'arena']
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

describe('agent dispatch', () => {
  for (const game of GAMES) {
    test(`${game}: factory resolves to an agent with the PreviewAgent shape`, async () => {
      const agent = await createGameAgent(game, 'easy')
      expect(typeof agent.preview).toBe('boolean')
      expect(typeof agent.reset).toBe('function')
      expect(typeof agent.act).toBe('function')
      expect(typeof agent.dispose).toBe('function')
      agent.dispose()
    })
  }
})

describe('preview stub agent', () => {
  for (const game of GAMES) {
    test(`${game}: stub has preview true and plays a legal counter-game action`, async () => {
      const core = createCounterGame('four')
      const agent = createStubAgent(game, 'easy', { core, seat: 0 })
      expect(agent.preview).toBe(true)
      agent.reset(7)
      const s = core.init(7)
      const out = await agent.act(core.observe(s, 0), s)
      expect(Array.isArray(out)).toBe(true)
      expect(out.length).toBe(1)
      expect(core.legal(s, 0).map(core.encodeAction)).toContain(out[0]!)
      agent.dispose()
    })
  }

  test('stub is deterministic per reset seed', async () => {
    const core = createCounterGame('four')
    const s = core.init(3)
    const run = async () => {
      const a = createStubAgent('four', 'hard', { core, seat: 0 })
      a.reset(11)
      const picks: number[] = []
      for (let i = 0; i < 10; i++) picks.push((await a.act(core.observe(s, 0), s))[0]!)
      return picks
    }
    expect(await run()).toEqual(await run())
  })

  test('realtime game with no legal list returns a neutral single-int action', async () => {
    const core = createDriftGame('fighter')
    const a = createStubAgent('fighter', 'champion', { core, seat: 1 })
    a.reset(1)
    const s = core.init(1)
    expect(await a.act(core.observe(s, 1), s)).toEqual([0])
  })

  test('every level is accepted', async () => {
    for (const level of LEVELS) {
      const a = createStubAgent('word', level, { core: createCounterGame('four'), seat: 0 })
      expect(a.preview).toBe(true)
    }
  })

  test('without an injected core, the stub fails loudly at act time', async () => {
    const a = createStubAgent('chess', 'easy')
    a.reset(1)
    await expect(a.act({}, {})).rejects.toThrow(/chess/)
  })
})
