import { describe, expect, test } from 'bun:test'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { shotsToSink } from '@duelwise/agents/src/fleet/measure'
import { shipCells, type Placement } from '@duelwise/core/src/games/fleet'
import { makeRng } from '@duelwise/core/src/rng'
import { expectedHunting, fleetLuckLine, huntingShots, luckVerdict } from './luck'

type Hunt = { fired: number[]; fleet: Placement[] }

/** Uniform shots while hunting, always finishing a hit ship: the player the old baseline took as par. */
function uniformHunter(seed: number): Hunt {
  const rng = makeRng(seed)
  const fleet = randomFleet(rng)
  const on = new Map(fleet.flatMap((p) => shipCells(p).map((c) => [c, p] as const)))
  const fired: number[] = []
  const hits = new Set<number>()
  while (hits.size < 17) {
    const open = [...hits].filter((c) => !shipCells(on.get(c)!).every((x) => hits.has(x)))
    const near = open.flatMap((c) => [c % 10 > 0 ? c - 1 : -1, c % 10 < 9 ? c + 1 : -1, c - 10, c + 10]).filter((c) => c >= 0 && c < 100 && !fired.includes(c))
    const free = Array.from({ length: 100 }, (_, c) => c).filter((c) => !fired.includes(c))
    const pool = near.length > 0 ? near : free
    const cell = pool[rng.int(pool.length)]!
    fired.push(cell)
    if (on.has(cell)) hits.add(cell)
  }
  return { fired, fleet }
}

const verdicts = (hunter: (seed: number) => Hunt, games: number, base: number) => {
  const tally = { lucky: 0, 'about even': 0, unlucky: 0 }
  for (let i = 0; i < games; i++) {
    const hunt = hunter(base + i)
    tally[luckVerdict(huntingShots(hunt.fired, hunt.fleet), expectedHunting(hunt.fleet, 5))]++
  }
  return tally
}

describe('the luck baseline', () => {
  test('good technique is not luck: a checkerboard hunter that finishes its ships reads as roughly balanced', () => {
    const t = verdicts((seed) => shotsToSink('medium', seed), 500, 70_000)
    expect(t.lucky + t['about even'] + t.unlucky).toBe(500)
    // The uniform baseline this replaces read 278 lucky, 208 even, 14 unlucky for this same kind of hunter.
    for (const n of Object.values(t)) {
      expect(n).toBeGreaterThan(120)
      expect(n).toBeLessThan(220)
    }
  }, 30_000)

  test('a careless hunt is not called lucky for being careless', () => {
    const t = verdicts(uniformHunter, 200, 80_000)
    expect(t.unlucky).toBeGreaterThan(t.lucky)
  }, 30_000)

  test('the card names the careful hunt it compares with', () => {
    const line = fleetLuckLine({ won: true, winnerShots: 46, found: 5, hunting: 23, expected: 31, opponent: 'Pip' })
    expect(line).toContain('a careful hunt needs about 31')
    expect(line).not.toContain('random hunt')
  })
})
