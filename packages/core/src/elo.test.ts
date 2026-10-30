import { describe, expect, test } from 'bun:test'
import { expected, kFor, ladderToElo, update } from './elo'

describe('elo', () => {
  test('expected is 0.5 for equal ratings and about 0.7597 for +200', () => {
    expect(expected(1500, 1500)).toBe(0.5)
    expect(expected(1600, 1400)).toBeCloseTo(0.7597, 4)
    expect(expected(1400, 1600) + expected(1600, 1400)).toBeCloseTo(1, 12)
  })

  test('1500 vs 1500 win with k 32 gives 1516', () => {
    expect(update(1500, 1500, 1, 32)).toBe(1516)
    expect(update(1500, 1500, 0, 32)).toBe(1484)
    expect(update(1500, 1500, 0.5, 32)).toBe(1500)
  })

  test('beating a stronger opponent gains more', () => {
    expect(update(1400, 1600, 1, 24) - 1400).toBeGreaterThan(update(1600, 1400, 1, 24) - 1600)
  })

  test('k is 40 for a first 10 games, then 24', () => {
    expect(kFor(0)).toBe(40)
    expect(kFor(9)).toBe(40)
    expect(kFor(10)).toBe(24)
    expect(kFor(500)).toBe(24)
  })
})

describe('ladderToElo', () => {
  test('anchors Easy at 1000 and rises with each stronger level', () => {
    const out = ladderToElo(
      [
        { lower: 'easy', upper: 'medium', score: 0.76 },
        { lower: 'medium', upper: 'hard', score: 0.7 },
        { lower: 'hard', upper: 'champion', score: 0.64 },
      ],
      { level: 'easy', elo: 1000 },
    )
    expect(out.easy).toBe(1000)
    expect(out.medium!).toBeGreaterThan(out.easy!)
    expect(out.hard!).toBeGreaterThan(out.medium!)
    expect(out.champion!).toBeGreaterThan(out.hard!)
    // 0.76 score is about +200 Elo.
    expect(out.medium! - 1000).toBeCloseTo(400 * Math.log10(0.76 / 0.24), 6)
  })

  test('pair order does not matter and a missing pair stops the chain', () => {
    const out = ladderToElo(
      [
        { lower: 'medium', upper: 'hard', score: 0.7 },
        { lower: 'easy', upper: 'medium', score: 0.76 },
      ],
      { level: 'easy', elo: 1000 },
    )
    expect(out.hard).toBeDefined()
    expect(out.champion).toBeUndefined()
  })

  test('extreme scores are clamped to finite values', () => {
    const out = ladderToElo([{ lower: 'easy', upper: 'medium', score: 1 }], { level: 'easy', elo: 1000 })
    expect(Number.isFinite(out.medium!)).toBe(true)
  })

  test('works from a non-Easy anchor', () => {
    const out = ladderToElo([{ lower: 'easy', upper: 'medium', score: 0.76 }], { level: 'medium', elo: 1200 })
    expect(out.medium).toBe(1200)
    expect(out.easy!).toBeLessThan(1200)
  })
})
