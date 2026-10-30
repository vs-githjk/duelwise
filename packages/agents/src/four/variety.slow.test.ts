import { describe, expect, test } from 'bun:test'
import { CHAMPION_LINE, HARD_LINE, REPLAY_SEED_SETS, REPLAY_WIN_LIMIT, replay } from '../measure/four-replay'

// Judge round 1 found one memorized line that beat Champion (and another that beat Hard) on every seed, because both levels
// played the same moves every game. Run explicitly: bun test packages/agents/src/four/variety.slow.test.ts (about 20 minutes).
const seeds = REPLAY_SEED_SETS[0]!

describe('replaying one winning line does not work twice', () => {
  for (const [level, line] of [
    ['hard', HARD_LINE],
  ] as const) {
    test(`${level}: the human line wins at most once in 20 seeded games`, async () => {
      let wins = 0
      for (const seed of seeds) if (await replay(level, line, seed)) wins++
      expect(wins).toBeLessThan(2)
    }, 900_000)
  }

  test('champion: the human line wins at most 3 of 60 seeded games across 3 independent seed sets', async () => {
    let wins = 0
    for (const set of REPLAY_SEED_SETS) for (const seed of set) if (await replay('champion', CHAMPION_LINE, seed)) wins++
    expect(wins).toBeLessThan(REPLAY_WIN_LIMIT)
  }, 3_600_000)
})
