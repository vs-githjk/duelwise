import { describe, expect, test } from 'bun:test'
import { LEVEL_MALLET, RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import { MOUSE_DELAY_FRAMES } from '@duelwise/core/src/games/puck/bots'
import { botSpec, measureBots, medianLag, pipSpec, playRecorded } from './puck'

// Human-hands mode: a gate bot plays on the rule mallet (what the browser gives the person: speed 6, acceleration 120) after a human reaction
// delay, while the agent seat keeps its own level's hands. The old mode (bot on the level's mallet) stays the default.

describe('gate bots on human hands', () => {
  test('default: the bot keeps its level mallet (old mode unchanged)', async () => {
    const g = await playRecorded([pipSpec(), botSpec('striker', 'easy', 12)], 5)
    expect(g.seats[1].peakSpeed).toBeLessThanOrEqual(LEVEL_MALLET.easy.speed + 1e-6)
  }, 120_000)

  test('human hands: the bot moves faster than the level mallet, never past the rule cap, with the delay it was given', async () => {
    const g = await playRecorded([pipSpec(), botSpec('striker', 'easy', 12, 'human')], 5)
    expect(g.seats[1].peakSpeed).toBeGreaterThan(LEVEL_MALLET.hard.speed)
    expect(g.seats[1].peakSpeed).toBeLessThanOrEqual(RULE_MALLET_SPEED + 1e-6)
    expect(medianLag(g.seats[1].lagHist)).toBeGreaterThanOrEqual(12)
    // The agent seat stays on its level hands.
    expect(g.seats[0].peakSpeed).toBeLessThanOrEqual(LEVEL_MALLET.easy.speed + 1e-6)
  }, 120_000)

  test('the delay is a parameter', async () => {
    const g = await playRecorded([pipSpec(), botSpec('mouse', 'easy', 18, 'human')], 6)
    expect(medianLag(g.seats[1].lagHist)).toBeGreaterThanOrEqual(18)
    expect(MOUSE_DELAY_FRAMES).toBe(11)
  }, 120_000)

  test('measureBots passes the mode through: a human-hands striker beats Pip more often than a level-hands one', async () => {
    const run = (hands?: 'human') => measureBots(pipSpec(), ['striker'], { games: 6, botDelay: 12, botHands: hands })
    const level = await run()
    const human = await run('human')
    expect(human.botHands).toBe('human')
    expect(level.botHands).toBe('level')
    expect(human.rows[0]!.score).toBeLessThanOrEqual(level.rows[0]!.score)
  }, 300_000)

  test('the mouse bot on human hands at its 11-frame delay beats random in at least 9 of 10 matches (it is a competent stand-in)', async () => {
    let wins = 0
    for (let i = 0; i < 10; i++) {
      const swap = i % 2 === 1
      const mouse = botSpec('mouse', 'hard', MOUSE_DELAY_FRAMES, 'human')
      const rand = botSpec('random', 'hard')
      const g = await playRecorded(swap ? [rand, mouse] : [mouse, rand], 40 + i)
      if (g.winner === (swap ? 1 : 0)) wins++
    }
    expect(wins).toBeGreaterThanOrEqual(9)
  }, 300_000)
})
