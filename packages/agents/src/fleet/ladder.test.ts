import { describe, expect, test } from 'bun:test'
import type { Level } from '@duelwise/core/src/product'
import { LEVELS } from '../runtime/levels'
import { runMatches, type GameRecord } from '../measure/harness'
import { wilson } from '../measure/ladder'

// Fleet is not in the dispatch table yet, so the harness gets the core and the agents by module path (no GameId needed).
const CORE = { module: '@duelwise/core/src/games/fleet', export: 'createFleetCore' }
const FLEET_AGENT = import.meta.dir + '/agent.ts'
// The random-legal-move baseline. The stub agent plays on the core the harness hands it, so the file name does not matter.
const RANDOM_AGENT = import.meta.dir + '/../measure/four-random.ts'

const GAMES_PER_SEAT = 400

type Ref = { level: Level; module: string }

/** A plays B over GAMES_PER_SEAT games on each seat (the harness puts A on seat index % 2); returns A's Wilson 95% lower bound per seat. */
async function lowerBounds(a: Ref, b: Ref, seedBase: number): Promise<[number, number]> {
  const n = GAMES_PER_SEAT * 2
  const summary = await runMatches(
    { game: 'four', core: CORE, a, b, seeds: Array.from({ length: n }, (_, i) => seedBase + i) },
    { processes: 1 },
  )
  const points = (seat: 0 | 1) => summary.games.filter((g: GameRecord) => g.seatOfA === seat).reduce((s, g) => s + g.scoreA, 0)
  return [wilson(points(0), GAMES_PER_SEAT)[0], wilson(points(1), GAMES_PER_SEAT)[0]]
}

describe('fleet level ladder, through the real harness', () => {
  test('every game finishes with a winner', async () => {
    const summary = await runMatches(
      { game: 'four', core: CORE, a: { level: 'easy', module: FLEET_AGENT }, b: { level: 'easy', module: RANDOM_AGENT }, seeds: [1, 2, 3, 4] },
      { processes: 1 },
    )
    expect(summary.games).toHaveLength(4)
    for (const g of summary.games) expect(g.winner).not.toBeNull()
  }, 60_000)

  test('Pip beats a random-legal-move player on each seat (Wilson 95% lower bound above 0.5)', async () => {
    const [s0, s1] = await lowerBounds({ level: 'easy', module: FLEET_AGENT }, { level: 'easy', module: RANDOM_AGENT }, 10_000)
    expect(s0).toBeGreaterThan(0.5)
    expect(s1).toBeGreaterThan(0.5)
  }, 600_000)

  for (let i = 0; i + 1 < LEVELS.length; i++) {
    const lower = LEVELS[i]!
    const upper = LEVELS[i + 1]!
    test(`${upper} beats ${lower} on each seat (Wilson 95% lower bound above 0.5)`, async () => {
      const [s0, s1] = await lowerBounds({ level: upper, module: FLEET_AGENT }, { level: lower, module: FLEET_AGENT }, 20_000 + i * 100_000)
      expect(s0).toBeGreaterThan(0.5)
      expect(s1).toBeGreaterThan(0.5)
    }, 600_000)
  }
})
