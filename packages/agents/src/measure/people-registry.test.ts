import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GameId, Level } from '@duelwise/core/src/product'
import { FLEET_LEVELS } from '../fleet/levels'
import { FOUR_LEVELS } from '../four/agent'
import { SLACK_LEVELS } from '../slack/levels'
import { parseRegistry, PeopleSchema } from '../registry'
import { ALL_GAMES, LEVELS, gameBest, fleetLabel, peopleSource, readStaged, replaceLevelLine, slackLabel, TURN_GAMES } from './a9-apply'
import { checkPeopleBlock, type PeopleEstimate } from './people'

// A9: every published level carries the people block its own measurement wrote, and what a level plays is what was measured.
const REGISTRY_DIR = join(import.meta.dir, '../../registry')
const load = (game: string): ReturnType<typeof parseRegistry> => parseRegistry(JSON.parse(readFileSync(join(REGISTRY_DIR, `${game}.json`), 'utf8')))

describe('every published level has a people block from its measurement (C1)', () => {
  for (const game of ALL_GAMES) {
    const reg = load(game)
    for (const level of LEVELS) {
      if (!reg.levels[level]) continue
      test(`${game} ${level}: the block is present, consistent with its own parts, and is the eval file's block`, () => {
        const people = reg.measured[level]?.people
        expect(people, `${game} ${level} is published with no people block`).toBeDefined()
        expect(checkPeopleBlock(people as PeopleEstimate, level)).toEqual([])
        const src = peopleSource(game as GameId, level)
        expect(src, `${game} ${level} has no measurement in packages/agents/eval/people`).not.toBeNull()
        expect(people).toEqual(PeopleSchema.parse(src!.estimate))
      })
    }
  }
  test('a level not published has no people block (nothing is claimed for it)', () => {
    for (const game of ALL_GAMES) {
      const reg = load(game)
      for (const level of LEVELS) if (!reg.levels[level]) expect(reg.measured[level]?.people).toBeUndefined()
    }
  })
})

describe('a ceiling is the best the game could do (the ceiling line may not contradict a stronger level)', () => {
  for (const game of ALL_GAMES) {
    test(`${game}: no ceiling-verdict level has a same-game level scoring above the ceiling interval, and every ceiling level reaches it`, () => {
      const reg = load(game)
      const blocks = LEVELS.flatMap((l) => (reg.measured[l]?.people ? [{ level: l, p: reg.measured[l]!.people as PeopleEstimate }] : []))
      const best = gameBest(game as GameId)
      for (const { level, p } of blocks) {
        if (p.verdict !== 'ceiling') {
          expect(p.ceiling, `${game} ${level} is not at a ceiling but carries a ceiling block`).toBeUndefined()
          continue
        }
        const c = p.ceiling!
        for (const other of blocks) {
          expect(other.p.panel.average.value, `${game}: ${other.level} scores above the ${level} ceiling`).toBeLessThanOrEqual(c.ci95[1])
        }
        expect(best, `${game} ${level} has a ceiling but the eval file has no best settings`).not.toBeNull()
        expect(c.value, `${game} ${level}: the ceiling is not the best measured settings`).toBe(best!.value)
        expect(p.panel.average.ci95[1], `${game} ${level} does not reach its ceiling`).toBeGreaterThanOrEqual(c.ci95[0])
      }
    })
  }
})

describe('what a level plays is what its people measurement played', () => {
  for (const game of TURN_GAMES.filter((g) => g !== 'holdem')) {
    const reg = load(game)
    for (const level of LEVELS) {
      if (!reg.levels[level]) continue
      test(`${game} ${level}: every setting the measurement recorded is the registry's setting`, () => {
        const src = peopleSource(game, level)!
        const shipped = reg.levels[level]!.config
        for (const [k, v] of Object.entries(src.config ?? {})) {
          if (k === 'algorithm' || k === 'snapshot' || k === 'selfPlayGames') continue
          expect([k, shipped[k]]).toEqual([k, v])
        }
      })
    }
  }
  test('the code tables hold the staged settings (four, fleet, crosscurrent)', () => {
    for (const level of ['easy', 'medium'] as Level[]) {
      const four = readStaged('four')[level]?.config
      if (four) expect(FOUR_LEVELS[level]).toMatchObject({ sims: four.sims, temperature: four.temperature })
      const fleet = readStaged('fleet')[level]?.config
      if (fleet) expect(FLEET_LEVELS[level]).toMatchObject({ hunt: fleet.hunt, target: fleet.target, followRate: fleet.followRate })
      const slack = readStaged('slack')[level]?.config
      if (slack) expect(SLACK_LEVELS[level]).toMatchObject({ depth: slack.depth, noise: slack.noise, mobility: slack.mobility })
    }
  })
})

describe('algorithm labels name the settings they describe', () => {
  test('Crosscurrent search levels name their depth, Stormglass levels their hunt and follow-up', () => {
    const slack = load('slack')
    for (const level of LEVELS) {
      const cfg = SLACK_LEVELS[level]
      if (cfg.kind !== 'search') continue
      expect(String(slack.levels[level]!.config.algorithm).startsWith(slackLabel(cfg))).toBe(true)
      expect(String(slack.levels[level]!.config.algorithm).startsWith(`search-${cfg.depth}-ply`)).toBe(true)
    }
    const fleet = load('fleet')
    for (const level of LEVELS) {
      const cfg = FLEET_LEVELS[level]
      const label = String(fleet.levels[level]!.config.algorithm)
      // The two retuned levels get their label from the script; Vesper's and Sable's labels are the ones they were published with.
      if (level === 'easy' || level === 'medium') expect(label).toBe(fleetLabel(cfg))
      expect(label.startsWith(cfg.hunt === 'map' ? 'map-hunt' : cfg.hunt)).toBe(true)
      expect(fleet.levels[level]!.config).toMatchObject({ hunt: cfg.hunt, target: cfg.target, followRate: cfg.followRate })
    }
  })
  test('the labels read as the shipped algorithms', () => {
    expect(slackLabel({ depth: 3, mobility: false })).toBe('search-3-ply')
    expect(slackLabel({ depth: 6, mobility: true })).toBe('search-6-ply-mobility')
    expect(fleetLabel({ hunt: 'random', target: 'follow', followRate: 0.35 })).toBe('random-with-follow')
    expect(fleetLabel({ hunt: 'checkerboard', target: 'follow', followRate: 0.6 })).toBe('checkerboard-with-follow')
    expect(fleetLabel({ hunt: 'checkerboard', target: 'neighbours', followRate: 1 })).toBe('checkerboard-with-neighbours')
    expect(fleetLabel({ hunt: 'map', target: 'neighbours', followRate: 1 })).toBe('map-hunt-with-neighbours')
    expect(fleetLabel({ hunt: 'map', target: 'neighbours', followRate: 0.5 })).toBe('map-hunt-with-half-neighbours')
    expect(fleetLabel({ hunt: 'map', target: 'map', followRate: 1 })).toBe('map-hunt-with-map')
  })
})

describe('replaceLevelLine', () => {
  const src = 'x\nexport const T: R = {\n  easy: { a: 1 },\n  medium: { a: 2 },\n}\nexport const U = {\n  medium: { a: 9 },\n}\n'
  test('changes only the named level of the named table', () => {
    expect(replaceLevelLine(src, 'T', 'medium', '  medium: { a: 3 },')).toBe(src.replace('medium: { a: 2 }', 'medium: { a: 3 }'))
  })
  test('refuses a table or level it cannot find on one line', () => {
    expect(() => replaceLevelLine(src, 'V', 'easy', '')).toThrow('no table')
    expect(() => replaceLevelLine(src, 'T', 'hard', '')).toThrow('no one-line hard')
  })
})
