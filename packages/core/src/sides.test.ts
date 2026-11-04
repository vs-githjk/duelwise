import { describe, expect, test } from 'bun:test'
import { RANDOM_SIDE_GAMES, assignedSeat, hasRandomSide, sideForSeed, HUMAN_SEAT_FLAG } from './sides'

describe('random sides', () => {
  test('the four named games assign sides and the rest do not', () => {
    expect([...RANDOM_SIDE_GAMES].sort()).toEqual(['chess', 'four', 'penalty', 'slack'])
    expect(hasRandomSide('chess')).toBe(true)
    expect(hasRandomSide('fleet')).toBe(false)
    expect(hasRandomSide('holdem')).toBe(false)
    expect(hasRandomSide('word')).toBe(false)
  })

  test('both seats are reachable and about even over many seeds', () => {
    for (const game of RANDOM_SIDE_GAMES) {
      let ones = 0
      for (let s = 0; s < 2000; s++) ones += sideForSeed(game, s * 7919 + 13)
      expect(ones).toBeGreaterThan(850)
      expect(ones).toBeLessThan(1150)
    }
  })

  test('the side is a pure function of game and seed, and seeds of any size give 0 or 1', () => {
    expect(sideForSeed('chess', 12345)).toBe(sideForSeed('chess', 12345))
    for (const s of [0, 1, 2 ** 31, 2 ** 32 - 1, 2 ** 40 + 5]) expect([0, 1]).toContain(sideForSeed('four', s))
  })

  test('a game with no random side is always seat 0', () => {
    for (let s = 0; s < 200; s++) {
      expect(sideForSeed('fleet', s)).toBe(0)
      expect(sideForSeed('holdem', s)).toBe(0)
    }
  })

  test('a stored flag decides; an old row with no flag is seat 0', () => {
    expect(assignedSeat(null)).toBe(0)
    expect(assignedSeat({})).toBe(0)
    expect(assignedSeat({ practice: true })).toBe(0)
    expect(assignedSeat({ [HUMAN_SEAT_FLAG]: 1 })).toBe(1)
    expect(assignedSeat({ [HUMAN_SEAT_FLAG]: 0 })).toBe(0)
    expect(assignedSeat({ [HUMAN_SEAT_FLAG]: 'x' })).toBe(0)
  })
})
