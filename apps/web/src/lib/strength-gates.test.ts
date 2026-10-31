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

const REGISTRY_DIR = join(import.meta.dir, '../../../../packages/agents/registry')
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const measuredSet = (reg: unknown) => LEVELS.filter((l) => verifiedStrength(reg as Registry, l))
const real = (game: string) => JSON.parse(readFileSync(join(REGISTRY_DIR, `${game}.json`), 'utf8')) as Registry

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
