import { describe, expect, test } from 'bun:test'
import { cairnCore, optimalTake } from '@duelwise/core/src/games/template/cairn'
import { LEVELS } from '../runtime/levels'
import { playGame, runMatches, type MatchJob } from '../measure/harness'
import { wilson } from '../measure/ladder'
import { CAIRN_LEVELS, createGameAgent } from './agent'

// The agent is not in the dispatch table (the template is not a product game), so the harness is
// given the core and the agent by module path, the same way harness.test.ts does for its toy game.
const CORE = { module: '@duelwise/core/src/games/template/cairn', export: 'createCairnCore' }
const AGENT = import.meta.dir + '/agent.ts'

function job(a: MatchJob['a'], b: MatchJob['b'], n: number): MatchJob {
  return { game: 'four', core: CORE, a, b, seeds: Array.from({ length: n }, (_, i) => 5000 + i) }
}

describe('cairn agent', () => {
  test('every level answers with a legal take for every pile', async () => {
    for (const level of LEVELS) {
      const agent = await createGameAgent(level)
      agent.reset(3)
      for (let pile = 1; pile <= 24; pile++) {
        const [code] = await agent.act({ pile, seat: 1, toMove: true })
        expect(code).toBeGreaterThanOrEqual(1)
        expect(code).toBeLessThanOrEqual(Math.min(3, pile))
      }
      agent.dispose()
    }
  })

  test('Champion always plays the perfect move; Easy does not', async () => {
    const champion = await createGameAgent('champion')
    const easy = await createGameAgent('easy')
    champion.reset(1)
    easy.reset(1)
    let easyPerfect = 0
    for (let i = 0; i < 300; i++) {
      const pile = 5 + (i % 20)
      expect((await champion.act({ pile, seat: 1, toMove: true }))[0]).toBe(optimalTake(pile))
      if ((await easy.act({ pile, seat: 1, toMove: true }))[0] === optimalTake(pile)) easyPerfect++
    }
    expect(easyPerfect).toBeLessThan(300 * 0.6)
  })

  test('the same seed gives the same game (the agent draws only from its seeded rng)', async () => {
    const play = async () => {
      const agents = [await createGameAgent('hard', { seat: 0 }), await createGameAgent('hard', { seat: 1 })] as const
      return (await playGame(cairnCore, [agents[0], agents[1]], 11)).hash
    }
    expect(await play()).toBe(await play())
  })

  test('levels are ordered: each level beats the one below with a Wilson lower bound above 50% over 400 games', async () => {
    const levels = Object.keys(CAIRN_LEVELS) as Array<keyof typeof CAIRN_LEVELS>
    for (let i = 0; i + 1 < levels.length; i++) {
      const summary = await runMatches(job({ level: levels[i + 1]!, module: AGENT }, { level: levels[i]!, module: AGENT }, 400), { processes: 1 })
      const [lo] = wilson(summary.scoreA, summary.games.length)
      expect(lo).toBeGreaterThan(0.5)
    }
  }, 120_000)
})
