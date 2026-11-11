import { describe, expect, test } from 'bun:test'
import type { Registry } from '@duelwise/agents/src/registry'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { PRACTICE_COPY, PRACTICE_PICKER_NOTE, agentVersionFor, count, limitsSentence, limitsText, strengthLine } from './strength'
import { buildCast } from '../../personas/cast'

const reg = {
  game: 'arena',
  champion: 'v1',
  versions: [],
  levels: { hard: { version: 'v1', config: {} } },
  measured: { hard: { metric: 'm', value: 0.7, ci95: [0.62, 0.8], n: 400, opponents: 'o', siteElo: 1091, measuredAt: 't', harness: 'bun', commit: 'c' } },
  unpublished: {},
  learnsFromHumans: false,
} as unknown as Registry

describe('Coldstore strength copy', () => {
  test('the persona table uses the same per-level Practice copy', () => {
    const arena = buildCast({ arena: reg }).find((row) => row.game === 'arena')!
    expect(arena.cells.medium).toEqual({ state: 'in-training', practice: true, reason: strengthLine(reg, 'medium') })
    for (const level of ['easy', 'medium', 'champion'] as const) expect(arena.cells[level]).toMatchObject({ practice: true })
  })
  test('a published level says how many of ten games it wins against the test bots, in words, with no Elo', () => {
    const line = strengthLine(reg, 'hard')
    expect(line).toBe('Beats our test bots in at least 6 of 10 games, including ones that peek, strafe and hold an angle; not yet measured against people.')
    expect(line).not.toMatch(/elo/i)
  })
  test('a level above Easy also says how it fares against the level below, so the bot scores cannot read Hard below Medium', () => {
    const m = reg.measured.hard!
    const r = { ...reg, levels: { easy: reg.levels.hard, medium: reg.levels.hard, hard: reg.levels.hard, champion: reg.levels.hard }, measured: { easy: m, medium: m, hard: m, champion: m }, versions: [{ gate: { ladder: { pairs: [{ lower: 'easy', upper: 'medium', lowerBound95: 0.62 }, { lower: 'medium', upper: 'hard', lowerBound95: 0.84 }, { lower: 'hard', upper: 'champion', lowerBound95: 0.98 }] } } }] } as unknown as Registry
    expect(strengthLine(r, 'hard')).toMatch(/ It beats Marlow in at least 8 of 10 seat-swapped matches\.$/)
    expect(strengthLine(r, 'medium')).toMatch(/ It beats Pip in at least 6 of 10 seat-swapped matches\.$/)
    expect(strengthLine(r, 'champion')).toMatch(/ It beats Vesper in at least 9 of 10/)
    expect(strengthLine(r, 'easy')).not.toMatch(/It beats/)
  })
  test('a level that is not published is a Practice level, and a record carries the registry version or preview', () => {
    expect(strengthLine(reg, 'easy')).toBe('In training: not yet measured. Easy reacts slower.')
    expect(strengthLine(null, 'medium')).toContain('Plays stronger than Easy')
    expect(strengthLine(null, 'hard')).toContain('not yet measured')
    expect(agentVersionFor(reg, 'hard')).toBe('v1')
    expect(agentVersionFor(reg, 'easy')).toBe('preview')
  })
  test('the limits sentence names only the limits a level has (Champion has no cap and no aim limit)', () => {
    expect(limitsSentence('champion')).toBe('It sees the match 50 ms late. It has no action cap and no aim limit. It sees only what its line of sight allows.')
    expect(limitsSentence('easy')).toBe('Easy reacts slower and has limited aim and actions. It sees only what its line of sight allows.')
    // A8 retune: Easy and Medium share a reaction time (24 frames) and differ in action cap, aim speed and aim noise.
    expect(LEVEL_LIMITS.arena.easy.delayFrames).toBeGreaterThanOrEqual(LEVEL_LIMITS.arena.medium.delayFrames)
    expect(LEVEL_LIMITS.arena.easy.apmCap!).toBeLessThan(LEVEL_LIMITS.arena.medium.apmCap!)
    expect(LEVEL_LIMITS.arena.easy.aimRateDegPerSec!).toBeLessThan(LEVEL_LIMITS.arena.medium.aimRateDegPerSec!)
    expect(LEVEL_LIMITS.arena.easy.aimNoiseDeg!).toBeGreaterThan(0)
    for (const l of ['medium', 'hard', 'champion'] as const) {
      const c = LEVEL_LIMITS.arena[l]
      expect(/cannot press/.test(limitsSentence(l))).toBe(c.apmCap !== null)
      expect(/cannot turn/.test(limitsSentence(l))).toBe(c.aimRateDegPerSec !== null)
    }
  })
  test('every action cap line says held buttons across a round restart are not counted, so the measured rate may read slightly above it', () => {
    for (const l of ['medium', 'hard'] as const) {
      const c = LEVEL_LIMITS.arena[l]
      if (c.apmCap === null || c.apmCap === undefined) continue
      expect(limitsSentence(l)).toContain(`${c.apmCap} actions a minute (not counting buttons it keeps held across a round restart)`)
      expect(limitsText(l)).toContain(`${c.apmCap} actions a minute (not counting buttons it keeps held across a round restart)`)
    }
  })
  test('counts are pluralised and the picker says levels in training have not passed the strength test', () => {
    expect(count(1, 'headshot')).toBe('1 headshot')
    expect(count(0, 'headshot')).toBe('0 headshots')
    expect(count(3, 'kill')).toBe('3 kills')
    expect(PRACTICE_PICKER_NOTE).toMatch(/Levels in training have not passed our strength test/)
    expect(PRACTICE_PICKER_NOTE).not.toMatch(/weaker than Easy/)
    expect(PRACTICE_PICKER_NOTE).not.toContain('tighter')
    // The note says Practice levels are looser than Easy, so tie that to the limiter config.
    const easy = LEVEL_LIMITS.arena.easy
    for (const lv of ['medium', 'hard', 'champion'] as const) {
      const c = LEVEL_LIMITS.arena[lv]
      expect(c.delayFrames).toBeLessThanOrEqual(easy.delayFrames)
      expect(c.apmCap == null || c.apmCap >= (easy.apmCap ?? 0)).toBe(true)
    }
  })
})

describe('Coldstore strength line against the people line', () => {
  const people = { band: { low: 0.42, high: 0.58 }, calibrated: 0.54, verdict: 'in-band' }
  const mk = (peopleGated: boolean, withPeople: boolean, ci95: [number, number] = [0.3, 0.4]): Registry =>
    ({
      ...reg,
      versions: [{ gate: { levels: { easy: peopleGated ? { peopleGated: true } : {} } } }],
      levels: { easy: reg.levels.hard },
      measured: { easy: { ...reg.measured.hard!, metric: 'score vs scripted peeker bot (weakest seat of the weakest gate bot)', ci95, ...(withPeople ? { people } : {}) } },
    }) as unknown as Registry
  test('a level with a people line ends with real players; without one it keeps "people"', () => {
    expect(strengthLine(mk(false, true, [0.62, 0.8]), 'easy')).toContain('hold an angle; not yet measured against real players.')
    expect(strengthLine(mk(false, false, [0.62, 0.8]), 'easy')).toContain('hold an angle; not yet measured against people.')
  })
  test('a people-gated level names the bot it loses to', () => {
    expect(strengthLine(mk(true, true), 'easy')).toContain('It loses to the peeking bot in most games; this level is set by the people test.')
    expect(strengthLine(mk(false, true), 'easy')).not.toContain('loses to')
  })
})
