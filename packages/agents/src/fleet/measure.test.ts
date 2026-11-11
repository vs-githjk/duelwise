import { describe, expect, test } from 'bun:test'
import { SHIPS, shipCells } from '@duelwise/core/src/games/fleet'
import { LEVELS } from '../runtime/levels'
import { parseRegistry, validateRegistry } from '../registry'
import fleetRegistry from '../../registry/fleet.json'
import { meanShots, MIN_SHOTS, SHOT_RUNS, shotsToSink } from './measure'

const FEWEST = SHIPS.reduce((a, b) => a + b, 0)

describe('mean shots to sink a random fleet', () => {
  test('the floor is the fleet: 17 cells can never be sunk in fewer shots', () => {
    expect(MIN_SHOTS).toBe(FEWEST)
    expect(FEWEST).toBe(17)
  })

  test('one hunt fires every shot at a new cell and ends on the shot that sinks the fleet', () => {
    for (const level of LEVELS) {
      for (let seed = 1; seed <= 20; seed++) {
        const hunt = shotsToSink(level, seed)
        expect(new Set(hunt.fired).size).toBe(hunt.fired.length)
        const cells = hunt.fleet.flatMap(shipCells)
        expect(cells.every((c) => hunt.fired.includes(c))).toBe(true)
        // The last shot was needed: without it one cell of the fleet is still afloat.
        expect(cells.includes(hunt.fired.at(-1)!)).toBe(true)
        expect(hunt.fired.length).toBeGreaterThanOrEqual(FEWEST)
        expect(hunt.fired.length).toBeLessThanOrEqual(100)
      }
    }
  })

  test('the same seed gives the same hunt', () => {
    expect(shotsToSink('champion', 7).fired).toEqual(shotsToSink('champion', 7).fired)
  })

  test('the mean carries its sample and an interval that holds it, and a stronger level needs fewer shots', () => {
    const stats = LEVELS.map((l, i) => meanShots(l, 5_000 + i * 1_000, 200))
    for (const s of stats) {
      expect(s.n).toBe(200)
      expect(s.ci95[0]).toBeLessThan(s.mean)
      expect(s.ci95[1]).toBeGreaterThan(s.mean)
      expect(s.mean).toBeGreaterThanOrEqual(FEWEST)
    }
    for (let i = 1; i < stats.length; i++) expect(stats[i]!.mean).toBeLessThan(stats[i - 1]!.mean)
  })
})

describe('the published registry', () => {
  test('every measured level carries script-made mean shots, a real count of shots and not a score', () => {
    const reg = parseRegistry(fleetRegistry)
    for (const level of LEVELS) {
      const shots = reg.measured[level]?.meanShots
      expect(shots, level).toBeDefined()
      expect(shots!.n).toBe(SHOT_RUNS)
      expect(shots!.mean).toBeGreaterThanOrEqual(FEWEST)
      expect(shots!.mean).toBeLessThanOrEqual(100)
    }
  })

  test('the levels land where an independent probe at n=1000 put them after the A9 retune (58.9, 51.9, 49.8, 45.2)', () => {
    const reg = parseRegistry(fleetRegistry)
    const probe = { easy: 58.9, medium: 51.9, hard: 49.8, champion: 45.2 } as const
    for (const level of LEVELS) expect(Math.abs(reg.measured[level]!.meanShots!.mean - probe[level])).toBeLessThan(1.5)
  })

  test('a registry claiming a mean under the fleet size is refused', () => {
    const bad = structuredClone(fleetRegistry) as { measured: { easy: { meanShots?: unknown } } }
    bad.measured.easy.meanShots = { mean: 0.98, ci95: [0.9, 1], n: 2000 }
    expect(validateRegistry(bad).ok).toBe(false)
  })
})
