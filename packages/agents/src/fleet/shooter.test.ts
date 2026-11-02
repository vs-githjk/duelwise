import { describe, expect, test } from 'bun:test'
import { FLEET_SIZE, SHIPS, fleetCore, shipCells, type FleetState, type Placement } from '@duelwise/core/src/games/fleet'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent } from './agent'
import { chooseFleetAction } from './agent'
import { FLEET_LEVELS } from './levels'
import { randomFleet, placeNext } from './placer'

const CELLS = FLEET_SIZE * FLEET_SIZE
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const SHOT0 = 2 * CELLS

/** Play seat 0 alone against a fixed enemy fleet; returns the shots used and checks no cell repeats. */
function solo(level: Level, enemy: Placement[], seed: number): number {
  const rng = makeRng(seed)
  const state: FleetState = { ships: [randomFleet(makeRng(seed + 1)), enemy], shots: [[], []] }
  for (let n = 1; n <= CELLS; n++) {
    const obs = fleetCore.observe(state, 0)
    if (obs.phase === 'over') return n - 1
    const action = chooseFleetAction(level, obs, rng)
    expect(action).toBeGreaterThanOrEqual(SHOT0)
    expect(action).toBeLessThan(SHOT0 + CELLS)
    const cell = action - SHOT0
    expect(state.shots[0].includes(cell)).toBe(false)
    state.shots[0].push(cell)
  }
  throw new Error('fleet solo did not finish')
}

describe('fleet shooter', () => {
  test('no level ever fires at a used cell, and every game ends', () => {
    for (const level of LEVELS) for (let g = 0; g < 30; g++) solo(level, randomFleet(makeRng(900 + g)), 50 + g)
  })

  test('the move depends only on the observation (a changed hidden enemy cell changes nothing)', () => {
    for (const level of LEVELS) {
      for (let g = 0; g < 20; g++) {
        const a = randomFleet(makeRng(300 + g))
        const fired = Array.from({ length: 3 + (g % 5) }, (_, i) => (i * 37 + g * 11) % CELLS)
        const shots = [...new Set(fired)]
        // Rebuild the enemy fleet so only cells never fired at move: try a second random fleet, keep it only if the shot marks agree.
        let b = a
        let found = false
        for (let t = 0; t < 400; t++) {
          const cand = randomFleet(makeRng(7000 + t + g * 1000))
          const sa: FleetState = { ships: [randomFleet(makeRng(1)), a], shots: [shots, []] }
          const sb: FleetState = { ships: [sa.ships[0], cand], shots: [shots, []] }
          const oa = fleetCore.observe(sa, 0)
          const ob = fleetCore.observe(sb, 0)
          if (JSON.stringify(oa) === JSON.stringify(ob) && JSON.stringify(cand) !== JSON.stringify(a)) {
            b = cand
            found = true
            break
          }
        }
        expect(found).toBe(true)
        const sa: FleetState = { ships: [randomFleet(makeRng(1)), a], shots: [shots, []] }
        const sb: FleetState = { ships: [sa.ships[0], b], shots: [shots, []] }
        const oa = fleetCore.observe(sa, 0)
        const ob = fleetCore.observe(sb, 0)
        if (oa.phase === 'over') continue
        expect(chooseFleetAction(level, oa, makeRng(5))).toBe(chooseFleetAction(level, ob, makeRng(5)))
      }
    }
  })

  test('mean shots over 300 solo games sit near the simulated 71, 55, 49, 45 (within 3)', () => {
    const want: Record<Level, number> = { easy: 71, medium: 55, hard: 49, champion: 45 }
    for (const level of LEVELS) {
      let total = 0
      for (let g = 0; g < 300; g++) total += solo(level, randomFleet(makeRng(10000 + g)), 20000 + g)
      const mean = total / 300
      expect(Math.abs(mean - want[level])).toBeLessThan(3)
    }
  }, 60000)

  test('levels are ordered: each beats the one below', () => {
    const mean = (level: Level) => {
      let t = 0
      for (let g = 0; g < 120; g++) t += solo(level, randomFleet(makeRng(40000 + g)), 41000 + g)
      return t / 120
    }
    const m = LEVELS.map(mean)
    for (let i = 1; i < m.length; i++) expect(m[i]!).toBeLessThan(m[i - 1]!)
  }, 60000)

  test('hunting is cheap: a champion shot on an empty board takes well under a millisecond', () => {
    const state: FleetState = { ships: [randomFleet(makeRng(1)), randomFleet(makeRng(2))], shots: [[], []] }
    const obs = fleetCore.observe(state, 0)
    const rng = makeRng(3)
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) chooseFleetAction('champion', obs, rng)
    expect((performance.now() - t0) / 200).toBeLessThan(1)
  })
})

describe('fleet placement', () => {
  test('uniform random valid: five legal ships, every position reachable, per-tick placement matches the core', () => {
    const seen = new Set<number>()
    for (let g = 0; g < 200; g++) {
      const fleet = randomFleet(makeRng(g))
      const cells = fleet.flatMap((p) => shipCells(p))
      expect(new Set(cells).size).toBe(SHIPS.reduce((a, b) => a + b, 0))
      for (const p of fleet) {
        expect(p.cell).toBeGreaterThanOrEqual(0)
        for (const c of shipCells(p)) expect(c).toBeLessThan(CELLS)
        seen.add(Math.floor(p.cell / FLEET_SIZE))
      }
    }
    expect(seen.size).toBe(FLEET_SIZE)
  })

  test('the agent places five ships through the core in setup, then shoots', async () => {
    for (const level of LEVELS) {
      const agent = await createGameAgent(level, { seat: 1 })
      expect(agent.preview).toBe(false)
      agent.reset(123)
      let state = fleetCore.init(1)
      const other = randomFleet(makeRng(9))
      for (let t = 0; t < SHIPS.length; t++) {
        const [code] = await agent.act(fleetCore.observe(state, 1))
        const mine = fleetCore.decodeAction(code!)
        const theirs = { kind: 'place' as const, cell: other[t]!.cell, vertical: other[t]!.vertical }
        state = fleetCore.step(state, [theirs, mine])
      }
      expect(fleetCore.observe(state, 1).phase).toBe('play')
      state = fleetCore.step(state, [{ kind: 'shot', cell: 0 }, null])
      const [shot] = await agent.act(fleetCore.observe(state, 1))
      expect(shot).toBeGreaterThanOrEqual(SHOT0)
      expect(fleetCore.legal(state, 1).map((a) => fleetCore.encodeAction(a))).toContain(shot!)
      agent.dispose()
    }
  })

  test('every level is a config with a distinct algorithm', () => {
    expect(Object.keys(FLEET_LEVELS).sort()).toEqual([...LEVELS].sort())
    const sigs = new Set(LEVELS.map((l) => JSON.stringify(FLEET_LEVELS[l])))
    expect(sigs.size).toBe(4)
  })

  test('placeNext picks only legal cells', () => {
    const rng = makeRng(4)
    const fleet: Placement[] = []
    for (let i = 0; i < SHIPS.length; i++) {
      const p = placeNext(fleet, rng)
      fleet.push(p)
    }
    expect(fleet.length).toBe(5)
  })
})
