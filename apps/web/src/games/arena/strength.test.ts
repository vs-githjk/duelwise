import { describe, expect, test } from 'bun:test'
import type { Registry } from '@duelwise/agents/src/registry'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { PRACTICE_COPY, PRACTICE_PICKER_NOTE, agentVersionFor, count, limitsSentence, strengthLine } from './strength'
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
    expect(LEVEL_LIMITS.arena.easy.delayFrames).toBeGreaterThan(LEVEL_LIMITS.arena.medium.delayFrames)
    expect(LEVEL_LIMITS.arena.easy.aimRateDegPerSec!).toBeLessThan(LEVEL_LIMITS.arena.medium.aimRateDegPerSec!)
    expect(LEVEL_LIMITS.arena.easy.aimNoiseDeg!).toBeGreaterThan(0)
    for (const l of ['medium', 'hard', 'champion'] as const) {
      const c = LEVEL_LIMITS.arena[l]
      expect(/cannot press/.test(limitsSentence(l))).toBe(c.apmCap !== null)
      expect(/cannot turn/.test(limitsSentence(l))).toBe(c.aimRateDegPerSec !== null)
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
