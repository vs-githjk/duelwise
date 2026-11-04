import { describe, expect, test } from 'bun:test'
import { ladderPairsPass as ladderPairsOk, verifiedStrength } from './strength-gates'

const seat = (n: number, points: number) => ({ seat: 0, n, points, ci95: [0.9, 1] })
const ladder = (n: number) => ({ game: 'chess', levels: { easy: { version: 'v1', config: {} } }, measured: { easy: { siteElo: 1000 } }, versions: [{ version: 'v1', gate: { baseline: { bySeat: [seat(n, n), { ...seat(n, n), seat: 1 }] } } }] })

test('strength requires 400 verified games on each seat, not a pooled score', () => {
  expect(verifiedStrength(ladder(200) as never, 'easy')).toBe(false)
  expect(verifiedStrength(ladder(400) as never, 'easy')).toBe(true)
  const lopsided = ladder(400)
  lopsided.versions[0]!.gate.baseline.bySeat[1]!.points = 0
  expect(verifiedStrength(lopsided as never, 'easy')).toBe(false)
})

test('missing or legacy seat evidence stays Practice', () => {
  const legacy = ladder(400)
  delete (legacy.versions[0]!.gate.baseline as { bySeat?: unknown }).bySeat
  expect(verifiedStrength(legacy as never, 'easy')).toBe(false)
})

test('withholding a level keeps the model configuration available for Practice', async () => {
  const { visibleRegistry } = await import('./strength-gates')
  const reg = ladder(200) as never
  const safe = visibleRegistry(reg)
  expect(safe.levels.easy).toBeUndefined()
  expect(safe.measured.easy).toBeUndefined()
  expect(safe.unpublishedConfig?.easy).toEqual({})
  expect(safe.unpublished?.easy).toContain('in training')
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fighterLaneC from './fixtures/lane-c-fighter-registry.json'
import type { Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { GAMES_PER_SEAT as FLEET_GAMES_PER_SEAT, buildFleetRegistry, seated, seatRows, seatsPass } from '@duelwise/agents/src/fleet/measure'
import type { GameRecord } from '@duelwise/agents/src/measure/harness'
import type { LadderResult } from '@duelwise/agents/src/measure/ladder'
import { GAMES_PER_SEAT as SLACK_GAMES_PER_SEAT, buildSlackRegistry, seated as slackSeated } from '@duelwise/agents/src/slack/measure'
import { GAMES_PER_SEAT as PENALTY_GAMES_PER_SEAT, buildPenaltyRegistry, seated as penaltySeated } from '@duelwise/agents/src/penalty/measure'

const REGISTRY_DIR = join(import.meta.dir, '../../../../packages/agents/registry')
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const measuredSet = (reg: unknown) => LEVELS.filter((l) => verifiedStrength(reg as Registry, l))
const real = (game: string) => JSON.parse(readFileSync(join(REGISTRY_DIR, `${game}.json`), 'utf8')) as Registry
/** The 95% Wilson lower bound of a score, for tests that state a pooled score passes on its own. */
const wilsonFloor = (points: number, n: number) => {
  const [z, p] = [1.959964, points / n]
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)
}

describe('every real registry: measured or Practice per game and level', () => {
  test('Four and Word keep the strength their own publisher gate proved', () => {
    expect(measuredSet(real('four'))).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(measuredSet(real('word'))).toEqual(['easy', 'medium', 'hard', 'champion'])
  })
  test('chess and Hold em were republished on the 400 per seat rule; Hold em Champion stays Practice', () => {
    expect(measuredSet(real('chess'))).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(measuredSet(real('holdem'))).toEqual(['easy', 'medium', 'hard'])
  })
  test('fighter and arena on this branch: exact sets', () => {
    expect(measuredSet(real('fighter'))).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(measuredSet(real('arena'))).toEqual(['easy', 'champion'])
  })
  test('Crosscurrent: exact set, from a scripted search, with 400 games on each seat of every row and no unpublished level', () => {
    const reg = real('slack')
    expect(measuredSet(reg)).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(reg.learnsFromHumans).toBe(false)
    expect(reg.unpublished).toEqual({})
    expect(reg.versions[0]!.status).toBe('measured')
    const gate = reg.versions[0]!.gate as { strengthSource: string; searchLimit: string; baseline: any; pairs: any[] }
    expect(gate.strengthSource).toContain('scripted search')
    expect(gate.searchLimit).toContain('never at a clock')
    expect(gate.pairs.map((p) => p.upper)).toEqual(['medium', 'hard', 'champion'])
    for (const row of [gate.baseline, ...gate.pairs]) {
      expect(row.bySeat.map((s: any) => [s.seat, s.n])).toEqual([[0, 400], [1, 400]])
      expect(row.bySeat[0].points + row.bySeat[1].points).toBe(row.points)
      expect(row.bySeat.every((s: any) => wilsonFloor(s.points, s.n) > 0.5)).toBe(true)
      expect(row.n).toBe(800)
    }
  })
  test('Stormglass: exact set, from a scripted solver, with 400 games on each seat of every row', () => {
    const reg = real('fleet')
    expect(measuredSet(reg)).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(reg.learnsFromHumans).toBe(false)
    const gate = reg.versions[0]!.gate as { strengthSource: string; baseline: any; pairs: any[] }
    expect(gate.strengthSource).toContain('scripted solver')
    expect(gate.pairs.map((p) => p.upper)).toEqual(['medium', 'hard', 'champion'])
    for (const row of [gate.baseline, ...gate.pairs]) {
      expect(row.bySeat.map((s: any) => [s.seat, s.n])).toEqual([[0, 400], [1, 400]])
      expect(row.bySeat[0].points + row.bySeat[1].points).toBe(row.points)
      expect(row.n).toBe(800)
    }
  })
  test('Twelve Yards: exact set, from scripted habit readers, with 1000 games on each seat of every row and no unpublished level', () => {
    const reg = real('penalty')
    expect(measuredSet(reg)).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(reg.learnsFromHumans).toBe(false)
    expect(reg.unpublished).toEqual({})
    expect(reg.versions[0]!.status).toBe('measured')
    const gate = reg.versions[0]!.gate as { strengthSource: string; searchLimit: string; baseline: any; pairs: any[] }
    expect(gate.strengthSource).toContain('scripted habit readers')
    expect(gate.searchLimit).toContain('no search and no clock')
    expect(gate.pairs.map((p) => p.upper)).toEqual(['medium', 'hard', 'champion'])
    for (const row of [gate.baseline, ...gate.pairs]) {
      expect(row.bySeat.map((s: any) => [s.seat, s.n])).toEqual([[0, 1000], [1, 1000]])
      expect(row.bySeat[0].points + row.bySeat[1].points).toBe(row.points)
      expect(row.bySeat.every((s: any) => wilsonFloor(s.points, s.n) > 0.5)).toBe(true)
      expect(row.n).toBe(2000)
    }
  })
  test('Four fails when its gate evidence is weakened', () => {
    const reg = real('four')
    const weak = structuredClone(reg) as any
    weak.versions[0].gate.pairs[1].n = 40
    expect(measuredSet(weak)).toEqual(['easy', 'medium'])
    const failedChallenger = structuredClone(reg) as any
    failedChallenger.versions.find((v: any) => v.version === 'v2').gate.passed = false
    expect(measuredSet(failedChallenger)).toEqual(['easy', 'medium', 'hard'])
    const failedPair = structuredClone(reg) as any
    failedPair.versions[0].gate.pairs[2].points = 50
    expect(measuredSet(failedPair)).toEqual(['easy', 'medium', 'hard'])
    for (const [k, patch] of [['siteSeat', { passed: false }], ['replay', { humanWins: 9 }], ['greedy', { notWins: 1 }], ['siteSeat', { points: 30 }]] as const) {
      const bad = structuredClone(reg) as any
      Object.assign(bad.versions[0].gate[k], patch)
      expect(measuredSet(bad)).toEqual([])
    }
  })
  test('Word fails when a level does not separate from the one below', () => {
    const weak = structuredClone(real('word')) as any
    weak.measured.hard.ci95 = [3.9, 4.0]
    expect(measuredSet(weak)).toEqual(['easy', 'medium'])
    const reversed = structuredClone(real('word')) as any
    reversed.measured.hard.value = 5
    expect(measuredSet(reversed)).toEqual(['easy', 'medium'])
  })
})

test('arena ladder shape (lowerBound95, no bySeat) is read; a failing bound demotes', () => {
  const arena = structuredClone(real('arena')) as any
  const pair = arena.versions[0].gate.ladder.pairs[0]
  expect(pair.lowerBound95).toBeGreaterThan(0.5)
  pair.lowerBound95 = 0.4
  expect(ladderPairsOk(arena.versions[0].gate.ladder.pairs, 'champion')).toBe(false)
  expect(ladderPairsOk(arena.versions[0].gate.ladder.pairs, 'medium')).toBe(true)
})

test('the old fighter registry lacks the new fireball25 gate', () => {
  expect(measuredSet(fighterLaneC)).toEqual([])
})

test('a ladder pair above the level does not demote it, and a pair without bySeat uses its Wilson bound', () => {
  const reg = structuredClone(fighterLaneC) as any
  const rows = reg.versions[0].gate.levels.hard.bots
  rows.push({ ...structuredClone(rows.find((r: any) => r.bot === 'zoner')), bot: 'fireball25' })
  reg.versions[0].gate.ladder.pairs[2].lowerBound = 0.01
  expect(verifiedStrength(reg, 'hard')).toBe(true)
  reg.versions[0].gate.ladder.pairs[1].lowerBound = 0.4
  expect(verifiedStrength(reg, 'hard')).toBe(false)
})

describe('Stormglass uses the per-seat ladder gate of chess and Hold em', () => {
  const seats = (n: number, first: number, second: number) => [{ seat: 0, n, points: first, ci95: [0, 1] }, { seat: 1, n, points: second, ci95: [0, 1] }]
  const pair = (lower: Level, upper: Level) => ({ lower, upper, n: 800, points: 640, bySeat: seats(400, 320, 320) })
  const fixture = () => ({
    game: 'fleet',
    levels: Object.fromEntries(LEVELS.map((l) => [l, { version: 'v1', config: {} }])),
    measured: Object.fromEntries(LEVELS.map((l) => [l, { siteElo: 1000 }])),
    versions: [{ version: 'v1', gate: { baseline: { label: 'random', n: 800, points: 780, bySeat: seats(400, 390, 390) }, pairs: [pair('easy', 'medium'), pair('medium', 'hard'), pair('hard', 'champion')] } }],
  }) as any

  test('a passing ladder shows every level', () => {
    expect(measuredSet(fixture())).toEqual(LEVELS)
  })
  test('one seat failing a pair keeps that level and every level above In training, on a pooled score that passes', () => {
    const reg = fixture()
    reg.versions[0].gate.pairs[1].bySeat = seats(400, 399, 200)
    expect(wilsonFloor(599, 800)).toBeGreaterThan(0.5)
    expect(measuredSet(reg)).toEqual(['easy', 'medium'])
  })
  test('one seat failing the random baseline keeps every level In training', () => {
    const reg = fixture()
    reg.versions[0].gate.baseline.bySeat = seats(400, 400, 200)
    expect(measuredSet(reg)).toEqual([])
  })
  test('a seat exactly at 0.5 fails, and so does a seat under 400 games', () => {
    const even = fixture()
    even.versions[0].gate.pairs[0].bySeat = seats(400, 320, 200)
    expect(measuredSet(even)).toEqual(['easy'])
    const short = fixture()
    short.versions[0].gate.pairs[2].bySeat = seats(399, 319, 319)
    expect(measuredSet(short)).toEqual(['easy', 'medium', 'hard'])
  })
  test('a missing pair, or a pair without seats, keeps the levels above it In training', () => {
    const missing = fixture()
    missing.versions[0].gate.pairs.splice(0, 1)
    expect(measuredSet(missing)).toEqual(['easy'])
    const pooledOnly = fixture()
    delete pooledOnly.versions[0].gate.pairs[0].bySeat
    expect(measuredSet(pooledOnly)).toEqual(['easy'])
  })
})

describe('what the Stormglass measurement writes reaches the gate', () => {
  const rows = (first: number, second: number, n = FLEET_GAMES_PER_SEAT) => [
    ...Array.from({ length: n }, (_, i) => ({ seatOfA: 0, scoreA: i < first ? 1 : 0 })),
    ...Array.from({ length: n }, (_, i) => ({ seatOfA: 1, scoreA: i < second ? 1 : 0 })),
  ] as GameRecord[]
  const stats = (points: number) => {
    const n = FLEET_GAMES_PER_SEAT * 2
    const floor = wilsonFloor(points, n)
    return { points, n, score: points / n, ci95: [floor, 1] as [number, number], stoppedEarly: false, passed: floor > 0.5 }
  }
  const row = (first: number, second: number) => seated(stats(first + second), rows(first, second))
  const ladder = (hard = row(300, 300), baseline = row(380, 380)): LadderResult => ({
    game: 'fleet',
    levels: [...LEVELS],
    pairs: [{ lower: 'easy', upper: 'medium', ...row(350, 350) }, { lower: 'medium', upper: 'hard', ...hard }, { lower: 'hard', upper: 'champion', ...row(280, 280) }],
    baseline: { label: 'random', ...baseline },
    elo: { easy: 1000, medium: 1300, hard: 1500, champion: 1600 },
  })
  const prior = (): Registry => ({
    game: 'fleet',
    champion: 'v1',
    versions: [{ version: 'v1', parent: null, createdAt: '2026-11-02T04:00:00.000Z', promotedAt: null, status: 'preview', artifacts: {}, sha256: {}, trainedSteps: 0, humanMatchesUsed: 0, gate: null }],
    levels: Object.fromEntries(LEVELS.map((l) => [l, { version: 'v1', config: { hunt: l } }])),
    measured: {},
    unpublished: {},
    unpublishedConfig: {},
    learnsFromHumans: false,
  })
  const build = (l: LadderResult) => buildFleetRegistry(prior(), l, { commit: 'abc1234', now: '2026-11-02T13:00:00.000Z' })

  test('a full pass publishes all four levels, with the seats in the gate and no learning claim', () => {
    const reg = build(ladder())
    expect(measuredSet(reg)).toEqual(LEVELS)
    expect(reg.learnsFromHumans).toBe(false)
    expect((reg.versions[0]!.gate as { strengthSource: string }).strengthSource).toContain('scripted solver')
    expect(reg.measured.easy!.opponents).toBe('random')
  })
  test('a pair that passes pooled but fails one seat is not published, and the levels above it keep their configs', () => {
    const reg = build(ladder(row(395, 205)))
    expect(stats(600).passed).toBe(true)
    expect(measuredSet(reg)).toEqual(['easy', 'medium'])
    expect(Object.keys(reg.levels)).toEqual(['easy', 'medium'])
    expect(reg.unpublished?.hard).toContain('from every seat')
    expect(reg.unpublished?.champion).toContain('in training')
    expect(reg.unpublishedConfig?.champion).toEqual({ hunt: 'champion' })
  })
  test('a failed baseline publishes nothing, and it still writes a valid registry', () => {
    const reg = build(ladder(undefined, row(395, 205)))
    expect(measuredSet(reg)).toEqual([])
    expect(reg.levels).toEqual({})
    expect(reg.unpublished?.easy).toContain('does not beat random')
  })
  test('seat rows split by seat, and a short seat does not pass', () => {
    const r = seatRows(rows(300, 100))
    expect(r.map((s) => [s.seat, s.n, s.points])).toEqual([[0, FLEET_GAMES_PER_SEAT, 300], [1, FLEET_GAMES_PER_SEAT, 100]])
    expect(seatsPass(r)).toBe(false)
    expect(seatsPass(seatRows(rows(399, 399, FLEET_GAMES_PER_SEAT - 1)))).toBe(false)
    expect(seatsPass(seatRows(rows(300, 300)))).toBe(true)
  })
})

describe('what the Crosscurrent measurement writes reaches the gate', () => {
  const rows = (first: number, second: number) => [
    ...Array.from({ length: SLACK_GAMES_PER_SEAT }, (_, i) => ({ seatOfA: 0, scoreA: i < first ? 1 : 0 })),
    ...Array.from({ length: SLACK_GAMES_PER_SEAT }, (_, i) => ({ seatOfA: 1, scoreA: i < second ? 1 : 0 })),
  ] as GameRecord[]
  const row = (first: number, second: number) => {
    const n = SLACK_GAMES_PER_SEAT * 2
    const floor = wilsonFloor(first + second, n)
    return slackSeated({ points: first + second, n, score: (first + second) / n, ci95: [floor, 1], stoppedEarly: false, passed: floor > 0.5 }, rows(first, second))
  }
  const ladder = (hard = row(300, 300), baseline = row(380, 380)): LadderResult => ({
    game: 'slack',
    levels: [...LEVELS],
    pairs: [{ lower: 'easy', upper: 'medium', ...row(350, 350) }, { lower: 'medium', upper: 'hard', ...hard }, { lower: 'hard', upper: 'champion', ...row(280, 280) }],
    baseline: { label: 'random', ...baseline },
    elo: { easy: 1000, medium: 1300, hard: 1500, champion: 1600 },
  })
  const prior = (): Registry => ({
    game: 'slack',
    champion: 'v1',
    versions: [{ version: 'v1', parent: null, createdAt: '2026-11-03T04:00:00.000Z', promotedAt: null, status: 'preview', artifacts: {}, sha256: {}, trainedSteps: 0, humanMatchesUsed: 0, gate: null }],
    levels: Object.fromEntries(LEVELS.map((l) => [l, { version: 'v1', config: {} }])),
    measured: {},
    unpublished: {},
    unpublishedConfig: {},
    learnsFromHumans: false,
  })
  const build = (l: LadderResult) => buildSlackRegistry(prior(), l, { commit: 'abc1234', now: '2026-11-03T13:00:00.000Z' })

  test('a full pass shows all four levels, with no learning claim', () => {
    const reg = build(ladder())
    expect(measuredSet(reg)).toEqual(LEVELS)
    expect(reg.learnsFromHumans).toBe(false)
    expect((reg.versions[0]!.gate as { strengthSource: string }).strengthSource).toContain('scripted search')
  })
  test('a pair that passes pooled but fails one seat keeps that level and the ones above In training', () => {
    const reg = build(ladder(row(395, 205)))
    expect(measuredSet(reg)).toEqual(['easy', 'medium'])
    expect(reg.unpublished?.hard).toContain('from every seat')
  })
  test('a gate with no seat rows shows nothing: a game the gate does not know stays In training', () => {
    const reg = build(ladder())
    delete (reg.versions[0]!.gate as any).baseline.bySeat
    expect(measuredSet(reg)).toEqual([])
  })
})

describe('what the Twelve Yards measurement writes reaches the gate', () => {
  const rows = (first: number, second: number) => [
    ...Array.from({ length: PENALTY_GAMES_PER_SEAT }, (_, i) => ({ seatOfA: 0, scoreA: i < first ? 1 : 0 })),
    ...Array.from({ length: PENALTY_GAMES_PER_SEAT }, (_, i) => ({ seatOfA: 1, scoreA: i < second ? 1 : 0 })),
  ] as GameRecord[]
  // The counts below are written for 400 games a seat; they scale to the real count, so a row keeps its proportions.
  const scale = PENALTY_GAMES_PER_SEAT / 400
  const row = (first400: number, second400: number) => {
    const first = first400 * scale
    const second = second400 * scale
    const n = PENALTY_GAMES_PER_SEAT * 2
    const floor = wilsonFloor(first + second, n)
    return penaltySeated({ points: first + second, n, score: (first + second) / n, ci95: [floor, 1], stoppedEarly: false, passed: floor > 0.5 }, rows(first, second))
  }
  const ladder = (hard = row(300, 300), baseline = row(380, 380)): LadderResult => ({
    game: 'penalty',
    levels: [...LEVELS],
    pairs: [{ lower: 'easy', upper: 'medium', ...row(350, 350) }, { lower: 'medium', upper: 'hard', ...hard }, { lower: 'hard', upper: 'champion', ...row(280, 280) }],
    baseline: { label: 'random', ...baseline },
    elo: { easy: 1000, medium: 1300, hard: 1500, champion: 1600 },
  })
  const prior = (): Registry => ({
    game: 'penalty',
    champion: 'v1',
    versions: [{ version: 'v1', parent: null, createdAt: '2026-11-03T04:00:00.000Z', promotedAt: null, status: 'preview', artifacts: {}, sha256: {}, trainedSteps: 0, humanMatchesUsed: 0, gate: null }],
    levels: Object.fromEntries(LEVELS.map((l) => [l, { version: 'v1', config: {} }])),
    measured: {},
    unpublished: {},
    unpublishedConfig: {},
    learnsFromHumans: false,
  })
  const build = (l: LadderResult) => buildPenaltyRegistry(prior(), l, { commit: 'abc1234', now: '2026-11-03T13:00:00.000Z' })

  test('a full pass shows all four levels, with no learning claim', () => {
    const reg = build(ladder())
    expect(measuredSet(reg)).toEqual(LEVELS)
    expect(reg.learnsFromHumans).toBe(false)
    expect((reg.versions[0]!.gate as { strengthSource: string }).strengthSource).toContain('scripted habit readers')
  })
  test('a pair that passes pooled but fails the keeper-first seat keeps that level and the ones above In training', () => {
    const reg = build(ladder(row(395, 205)))
    expect(measuredSet(reg)).toEqual(['easy', 'medium'])
    expect(reg.unpublished?.hard).toContain('from every seat')
  })
  test('a thin first seat on Pip against random keeps Pip and everything above In training', () => {
    const reg = build(ladder(row(300, 300), row(210, 380)))
    expect(measuredSet(reg)).toEqual([])
  })
  test('a gate with no seat rows shows nothing', () => {
    const reg = build(ladder())
    delete (reg.versions[0]!.gate as any).baseline.bySeat
    expect(measuredSet(reg)).toEqual([])
  })
  test('the config the site plays is the one the code holds', () => {
    const reg = build(ladder())
    expect(reg.levels.champion?.config).toMatchObject({ kind: 'sable', weight: 1.1, cap: 0.8 })
    expect(reg.levels.easy?.config).toMatchObject({ kind: 'pip' })
  })
})

describe('chess 2-ply bot gate follows R44', () => {
  const base = () => structuredClone(real('chess')) as any
  test('pooled below 0.7 or a seat below 0.6 keeps Hard and Champion Practice', () => {
    const pooled = base()
    pooled.versions[0].gate.twoPlyBot.points = 270
    expect(measuredSet(pooled)).toEqual(['easy', 'medium'])
    const seat = base()
    seat.versions[0].gate.twoPlyBot.bySeat[1].points = 110
    expect(measuredSet(seat)).toEqual(['easy', 'medium'])
  })
})
