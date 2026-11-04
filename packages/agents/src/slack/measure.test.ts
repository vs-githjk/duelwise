import { describe, expect, test } from 'bun:test'
import type { Level } from '@duelwise/core/src/product'
import type { GameRecord } from '../measure/harness'
import { wilson, type LadderResult, type PairResult } from '../measure/ladder'
import { parseRegistry } from '../registry'
import { LEVELS } from '../runtime/levels'
import slackPreview from '../../registry/slack.json'
import { SLACK_LEVELS } from './levels'
import { GAMES_PER_SEAT, buildSlackRegistry, seated, seatRows, seatsPass } from './measure'

/** A pair of games where A scored `a0` of `n` on seat 0 and `a1` of `n` on seat 1. */
function games(a0: number, a1: number, n = GAMES_PER_SEAT): GameRecord[] {
  const rows: GameRecord[] = []
  for (const [seat, pts] of [[0, a0], [1, a1]] as const) for (let i = 0; i < n; i++) rows.push({ seatOfA: seat, scoreA: i < pts ? 1 : 0 } as GameRecord)
  return rows
}
const pairStats = (g: GameRecord[]) => {
  const n = g.length
  const points = g.reduce((s, r) => s + r.scoreA, 0)
  const ci95 = wilson(points, n)
  return { points, n, score: points / n, ci95, stoppedEarly: false, passed: ci95[0] > 0.5 }
}
const lowers: Level[] = ['easy', 'medium', 'hard']
function ladderWith(seats: Record<string, [number, number]>, baseline: [number, number] = [380, 390]): LadderResult {
  const pairs = lowers.map((lower, i): PairResult => {
    const upper = LEVELS[i + 1]!
    const [a, b] = seats[upper] ?? [330, 320]
    const g = games(a, b)
    return { lower, upper, ...seated(pairStats(g), g) }
  })
  const bg = games(...baseline)
  const elo: LadderResult['elo'] = { easy: 1000 }
  for (const p of pairs) elo[p.upper] = elo[p.lower]! + 100 + 200 * (p.score - 0.5)
  return { game: 'slack', levels: [...LEVELS], pairs, baseline: { label: 'random', ...seated(pairStats(bg), bg) }, elo }
}
const prior = () => parseRegistry(structuredClone(slackPreview))
const META = { commit: 'abc1234', now: '2026-11-03T08:00:00.000Z' }

describe('the seat gate', () => {
  test('a seat needs the full 400 games and a Wilson lower bound above 0.5; a pooled pass is not enough', () => {
    expect(seatsPass(seatRows(games(330, 320)))).toBe(true)
    // 220 of 400 pooled with 300 of 400: pooled lower bound is above 0.5, the weak seat (0.55, lower about 0.50) is not.
    const weak = games(300, 200)
    expect(pairStats(weak).ci95[0]).toBeGreaterThan(0.5)
    expect(seatsPass(seatRows(weak))).toBe(false)
    expect(seatsPass(seatRows(games(330, 320, 399)))).toBe(false)
    expect(seatsPass(seatRows(games(330, 320).filter((g) => g.seatOfA === 0)))).toBe(false)
  })

  test('the lower bound is the real Wilson bound: 215 of 400 has 0.5 inside, 225 of 400 does not', () => {
    expect(wilson(215, 400)[0]).toBeLessThan(0.5)
    expect(seatsPass(seatRows(games(225, 225)))).toBe(true)
    expect(seatsPass(seatRows(games(215, 400)))).toBe(false)
  })

  test('seated() fails a pair whose pooled score passes but whose seat does not', () => {
    const g = games(300, 200)
    expect(pairStats(g).passed).toBe(true)
    expect(seated(pairStats(g), g).passed).toBe(false)
  })
})

describe('buildSlackRegistry', () => {
  test('every pair clears both seats: all four levels are published with their measured blocks and the gate', () => {
    const reg = buildSlackRegistry(prior(), ladderWith({}), META)
    expect(Object.keys(reg.levels).sort()).toEqual([...LEVELS].sort())
    expect(reg.unpublished).toEqual({})
    for (const level of LEVELS) {
      const m = reg.measured[level]!
      expect(m.commit).toBe('abc1234')
      expect(m.harness).toBe('bun')
      expect(m.n).toBe(800)
    }
    const v = reg.versions[0]!
    expect(v.status).toBe('measured')
    const gate = v.gate as { gamesPerSeat: number; pairs: Array<{ bySeat: Array<{ n: number }> }>; baseline: { bySeat: unknown[] } }
    expect(gate.gamesPerSeat).toBe(400)
    expect(gate.pairs).toHaveLength(3)
    expect(gate.pairs.every((p) => p.bySeat.every((s) => s.n === 400))).toBe(true)
    expect(gate.baseline.bySeat).toHaveLength(2)
    expect(reg.learnsFromHumans).toBe(false)
  })

  test('the played config is the one the code holds, every field of it', () => {
    const reg = buildSlackRegistry(prior(), ladderWith({}), META)
    for (const level of LEVELS) expect(reg.levels[level]!.config).toMatchObject(SLACK_LEVELS[level])
    expect(reg.levels.champion!.config).toMatchObject({ nodeCap: 120_000, exactEmpties: 8, openingNoise: { above: 50, noise: 30 } })
  })

  test('a level that fails on one seat stays In training, and so does everything above it; the gate is not loosened', () => {
    // Vesper (hard) beats Marlow overall but not from seat 1.
    const reg = buildSlackRegistry(prior(), ladderWith({ hard: [300, 200] }), META)
    expect(Object.keys(reg.levels).sort()).toEqual(['easy', 'medium'])
    expect(reg.unpublished?.hard).toMatch(/in training: .*from every seat/)
    expect(reg.unpublished?.champion).toMatch(/in training/)
    expect(reg.unpublishedConfig?.hard).toBeDefined()
    expect(reg.measured.hard).toBeUndefined()
    expect(reg.measured.champion).toBeUndefined()
  })

  test('Pip failing the random baseline on a seat keeps every level In training', () => {
    const reg = buildSlackRegistry(prior(), ladderWith({}, [300, 200]), META)
    expect(Object.keys(reg.levels)).toEqual([])
    expect(Object.keys(reg.unpublished ?? {}).sort()).toEqual([...LEVELS].sort())
  })

  test('a ladder with no baseline is refused', () => {
    const l = ladderWith({})
    delete l.baseline
    expect(() => buildSlackRegistry(prior(), l, META)).toThrow(/baseline/)
  })
})
