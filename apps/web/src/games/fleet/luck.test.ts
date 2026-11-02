import { describe, expect, test } from 'bun:test'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { shotsToSink } from '@duelwise/agents/src/fleet/measure'
import { shipCells, type Placement } from '@duelwise/core/src/games/fleet'
import { makeRng } from '@duelwise/core/src/rng'
import { fleetLuckLine, luckScore, luckScoreSliced, luckVerdict } from './luck'

type Hunt = { fired: number[]; fleet: Placement[] }

/** Uniform shots while hunting, always finishing a hit ship: a careless player. */
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

const zOf = (hunt: Hunt) => {
  const s = luckScore(hunt.fired, hunt.fleet)
  return (s.hits - s.expected) / Math.sqrt(Math.max(s.variance, 0.25))
}
const tally = (hunter: (seed: number) => Hunt, games: number, base: number) => {
  const t = { lucky: 0, 'about even': 0, unlucky: 0 }
  let zsum = 0
  for (let i = 0; i < games; i++) {
    const hunt = hunter(base + i)
    const s = luckScore(hunt.fired, hunt.fleet)
    t[luckVerdict(s)]++
    zsum += (s.hits - s.expected) / Math.sqrt(Math.max(s.variance, 0.25))
  }
  return { t, mean: zsum / games }
}

describe('the luck measure is skill neutral', () => {
  test('the first shot of a match is worth about the share of squares that hold a ship, more at the centre', () => {
    const fleet = randomFleet(makeRng(5))
    const s = luckScore([42], fleet)
    expect(s.shots).toBe(1)
    expect(s.expected).toBeGreaterThan(0.12)
    expect(s.expected).toBeLessThan(0.32)
  })

  test('spread over timer ticks the score is exactly the synchronous one, a few ticks per shot, and it stops when the page leaves', async () => {
    const hunt = shotsToSink('medium', 70_002)
    let pauses = 0
    const sliced = await luckScoreSliced(hunt.fired, hunt.fleet, async () => { pauses++ })
    expect(sliced).toEqual(luckScore(hunt.fired, hunt.fleet))
    expect(pauses).toBeGreaterThanOrEqual(hunt.fired.length)
    let alive = true
    const gone = await luckScoreSliced(hunt.fired, hunt.fleet, async () => { alive = false }, () => alive)
    expect(gone).toBeNull()
  })

  test('the same shots against the same fleet always score the same', () => {
    const hunt = shotsToSink('medium', 70_001)
    expect(luckScore(hunt.fired, hunt.fleet)).toEqual(luckScore(hunt.fired, hunt.fleet))
  })

  test('good technique is not luck: a checkerboard hunter that finishes its ships is not read as lucky more often than unlucky', () => {
    const { t, mean } = tally((seed) => shotsToSink('medium', seed), 40, 70_000)
    expect(t.lucky + t['about even'] + t.unlucky).toBe(40)
    expect(Math.abs(mean)).toBeLessThan(0.5)
    expect(t.lucky).toBeLessThan(t.unlucky + 10)
    expect(t.unlucky).toBeLessThan(t.lucky + 10)
  }, 120_000)

  test('a careless hunter is not read as unlucky for being careless', () => {
    const { t, mean } = tally(uniformHunter, 40, 80_000)
    expect(Math.abs(mean)).toBeLessThan(0.5)
    expect(t.lucky).toBeLessThan(t.unlucky + 10)
    expect(t.unlucky).toBeLessThan(t.lucky + 10)
  }, 120_000)

  test('a shot the player could not know was good still counts as luck: a lone hit on a far square scores above its chance', () => {
    // The first ten shots all miss on an empty corner and then one hits: the hit was a long shot only if its chance was small.
    const fleet = randomFleet(makeRng(11))
    const empty = Array.from({ length: 100 }, (_, c) => c).filter((c) => !fleet.some((p) => shipCells(p).includes(c)))
    const hit = shipCells(fleet[0]!)[0]!
    const lucky = luckScore([...empty.slice(0, 3), hit], fleet)
    expect(lucky.hits).toBe(1)
    expect(lucky.expected).toBeLessThan(1)
  })

  test('three hits in a row with no ship sunk make the next square close to certain: no afloat ship can lie wholly on the hits', () => {
    const fleet: Placement[] = [
      { id: 0, length: 5, cell: 0, vertical: false },
      { id: 1, length: 4, cell: 50, vertical: false },
      { id: 2, length: 3, cell: 70, vertical: false },
      { id: 3, length: 3, cell: 85, vertical: false },
      { id: 4, length: 2, cell: 98, vertical: false },
    ]
    const next = luckScore([0, 1, 2, 3], fleet).expected - luckScore([0, 1, 2], fleet).expected
    expect(next).toBeGreaterThan(0.85)
    expect(next).toBeLessThanOrEqual(1)
  })

  test('verdict bands are one standard deviation of chance either side', () => {
    expect(luckVerdict({ hits: 12, expected: 8, variance: 4 })).toBe('lucky')
    expect(luckVerdict({ hits: 9, expected: 8, variance: 4 })).toBe('about even')
    expect(luckVerdict({ hits: 8, expected: 8, variance: 4 })).toBe('about even')
    expect(luckVerdict({ hits: 7, expected: 8, variance: 4 })).toBe('about even')
    expect(luckVerdict({ hits: 5, expected: 8, variance: 4 })).toBe('unlucky')
  })
})

describe('the luck line', () => {
  const score = { shots: 46, hits: 21, expected: 17.6, variance: 8 }
  test('says the hits scored, the hits the chosen squares should have scored, and the verdict', () => {
    expect(fleetLuckLine({ won: true, winnerShots: 46, found: 5, score, opponent: 'Pip' })).toBe('You sank all five in 46 shots. You hit 21 of 46 shots; those squares should hit about 18. You ran lucky.')
    expect(fleetLuckLine({ won: false, winnerShots: 52, found: 3, score: { ...score, hits: 12, expected: 14 }, opponent: 'Pip' })).toBe('Pip sank your fleet in 52 shots. You hit 12 of 46 shots (three ships found); those squares should hit about 14. You ran about even.')
    expect(fleetLuckLine({ won: true, winnerShots: 46, found: 5, score, opponent: 'Pip', third: true })).not.toMatch(/\b(You|Your|you|your)\b/)
    expect(fleetLuckLine({ won: false, winnerShots: 52, found: 4, score, opponent: 'Pip' })).toMatch(/You ran lucky, and still lost on the chase\.$/)
  })
})
