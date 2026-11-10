import { describe, expect, test } from 'bun:test'
import type { PuckBotKind } from '@duelwise/core/src/games/puck/bots'
import type { GameId } from '@duelwise/core/src/product'
import { playGame } from '../measure/harness'
import { runLadder, wilson } from '../measure/ladder'
import { createBotAgent, createGameAgent, puckCoreAt } from './pip'

// The dry ladder: Pip is the only puck agent that exists before the trained nets, so this runs the Easy rung of the
// publish gate (plan Agents table) and the ladder code on it, to prove the measurement path end to end before the
// real levels arrive. All at Easy limits for both seats, bots included (R15: bots obey the level's hands).

const GAMES_PER_SEAT = 400
/** Wilson 95% lower-bound bars for Easy, per seat, from the plan's Agents table. */
const EASY_BARS: Array<[PuckBotKind, number]> = [['random', 0.85], ['striker', 0.35], ['goalie', 0.35]]

/** Pip's points against `bot` over `n` games with Pip in `seat`, seeds from `seed0`. */
async function pipPoints(bot: PuckBotKind, seat: 0 | 1, n: number, seed0: number): Promise<number> {
  const core = puckCoreAt('easy', 'easy')
  let points = 0
  for (let i = 0; i < n; i++) {
    const pip = await createGameAgent('easy', { seat })
    const opp = await createBotAgent(bot, 'easy', { seat: (1 - seat) as 0 | 1 })
    const { result } = await playGame(core, seat === 0 ? [pip, opp] : [opp, pip], seed0 + i, 40_000)
    points += result === null || result.winner === null ? 0.5 : result.winner === seat ? 1 : 0
    pip.dispose()
    opp.dispose()
  }
  return points
}

describe('dry ladder: Pip at Easy', () => {
  for (const [bot, bar] of EASY_BARS) {
    test(`clears the Easy gate bar against ${bot} (Wilson lower bound ${bar}) from both seats over ${GAMES_PER_SEAT} games each`, async () => {
      for (const seat of [0, 1] as const) {
        const points = await pipPoints(bot, seat, GAMES_PER_SEAT, 90_000 + seat * 10_000)
        expect(wilson(points, GAMES_PER_SEAT)[0]).toBeGreaterThan(bar)
      }
    }, 300_000)
  }

  test('the ladder runner takes Pip as the anchor and measures it against random', async () => {
    const result = await runLadder({
      game: 'puck' as unknown as GameId,
      levels: ['easy'],
      budget: { maxGames: 100, looks: [] },
      playPair: async () => {
        throw new Error('one level, no pairs')
      },
      baseline: {
        label: 'random',
        play: async (from, to) => {
          let points = 0
          for (let g = from; g < to; g += 2) points += (await pipPoints('random', 0, 1, 120_000 + g)) + (await pipPoints('random', 1, 1, 130_000 + g))
          return points
        },
      },
    })
    expect(result.elo.easy).toBe(1000)
    expect(result.pairs).toEqual([])
    expect(result.baseline?.n).toBe(100)
    expect(result.baseline?.passed).toBe(true)
  }, 120_000)
})
