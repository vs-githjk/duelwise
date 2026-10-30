import { describe, expect, test } from 'bun:test'
import { GREEDY_SEEDS, greedyMove, greedyTally } from '../measure/four-greedy'
import { fourFromMoves } from '@duelwise/core/src/games/four/rules'

// Judge round 2 found the Champion drawing and losing to a bot that only wins, blocks and prefers the centre.
// Run explicitly: bun test packages/agents/src/four/greedy.slow.test.ts (about 20 minutes).
describe('the 1-ply greedy bot', () => {
  test('takes a win, blocks, else the centre-most column', () => {
    expect(greedyMove(fourFromMoves([]))).toBe(3)
    expect(greedyMove(fourFromMoves([3, 0, 3, 0, 3, 1]))).toBe(3) // 6 drops: seat 0 to move wins in col 3
    expect(greedyMove(fourFromMoves([0, 6, 0, 6, 0]))).toBe(0) // 5 drops: seat 1 to move must block col 0 (the centre-most pick would be 3)
    expect(greedyMove(fourFromMoves([3, 3, 3, 3, 3, 3]))).toBe(2) // col 3 full
  })

  test('the Champion beats it in all 40 games, 20 in each seat', async () => {
    const t = await greedyTally('champion', GREEDY_SEEDS)
    expect(t).toEqual({ wins: 40, draws: 0, losses: 0 })
  }, 3_600_000)
})
