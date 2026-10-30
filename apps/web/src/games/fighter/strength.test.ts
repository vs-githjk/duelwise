import { describe, expect, test } from 'bun:test'
import type { Registry } from '@duelwise/agents/src/registry'
import { PRACTICE_COPY, agentVersionFor, isPublished, limitsExplainer, practiceResult, strengthLine } from './strength'

const reg = (over: Partial<Registry>): Registry =>
  ({
    game: 'fighter',
    champion: 'v1',
    versions: [],
    levels: { hard: { version: 'v1', config: {} } },
    measured: { hard: { metric: 'm', value: 0.7, ci95: [0.62, 0.8], n: 400, opponents: 'o', siteElo: 2768, measuredAt: 't', harness: 'bun', commit: 'c' } },
    unpublished: {},
    learnsFromHumans: false,
    ...over,
  }) as unknown as Registry

describe('fighter strength copy', () => {
  test('a published level says how many of ten games it wins against the test bots, rounded down, with no Elo', () => {
    const line = strengthLine(reg({}), 'hard')
    expect(line).toBe('Beats our test bots in at least 6 of 10 games, including loop tricks; not yet measured against people.')
    expect(line).not.toMatch(/elo/i)
  })

  test('an interval edge exactly on a game boundary is not lost to float error', () => {
    const r = reg({ measured: { hard: { ...reg({}).measured.hard!, ci95: [0.7, 0.9] } } })
    expect(strengthLine(r, 'hard')).toContain('at least 7 of 10')
  })

  test('a level that is not published is a Practice level (R32): early version, no strength or Elo number', () => {
    expect(strengthLine(reg({}), 'champion')).toBe(PRACTICE_COPY)
    expect(strengthLine(null, 'hard')).toBe(PRACTICE_COPY)
    expect(PRACTICE_COPY).toBe('Practice: an early version that has not passed our strength test yet.')
    expect(PRACTICE_COPY).not.toMatch(/\d|elo/i)
  })

  test('the recorded agent version is the registry version, or preview when nothing is published', () => {
    expect(agentVersionFor(reg({}), 'hard')).toBe('v1')
    expect(agentVersionFor(reg({}), 'champion')).toBe('preview')
    expect(agentVersionFor(null, 'hard')).toBe('preview')
  })

  test('isPublished needs both the level and its measured block', () => {
    expect(isPublished(reg({}), 'hard')).toBe(true)
    expect(isPublished(reg({ levels: {}, measured: {} }), 'hard')).toBe(false)
    expect(isPublished(null, 'hard')).toBe(false)
  })
})

describe('fighter strength copy names the closest call, and Champion is never described as capped (KC1)', () => {
  const withMetric = (metric: string, ci: [number, number], over: Partial<Registry> = {}): Registry =>
    reg({ measured: { hard: { ...reg({}).measured.hard!, metric, ci95: ci }, champion: { ...reg({}).measured.hard!, metric, ci95: ci } }, levels: { hard: { version: 'v1', config: {} }, champion: { version: 'v1', config: {} } }, ...over } as Partial<Registry>)

  test('Hard and Champion no longer read as the same line when their weakest bots differ', () => {
    const r = reg({
      levels: { hard: { version: 'v1', config: {} }, champion: { version: 'v1', config: {} } },
      measured: {
        hard: { ...reg({}).measured.hard!, metric: 'score vs scripted pokeloop bot (weakest of the gate bots)', ci95: [0.71, 0.8] },
        champion: { ...reg({}).measured.hard!, metric: 'score vs scripted sweepspam bot (weakest of the gate bots)', ci95: [0.71, 0.8] },
      },
    } as unknown as Partial<Registry>)
    const hard = strengthLine(r, 'hard')
    const champion = strengthLine(r, 'champion')
    expect(hard).toContain('at least 7 of 10')
    expect(hard).toContain('closest call was the crouch-poke bot')
    expect(champion).toContain('closest call was the sweep-spam bot')
    expect(hard).not.toBe(champion)
  })

  test('only a ladder that has Champion beat Hard with a lower bound above one half earns the head-to-head sentence', () => {
    const ladder = (lowerBound: number) => ({ gate: { ladder: { pairs: [{ lower: 'hard', upper: 'champion', lowerBound }] } } })
    const base = withMetric('score vs scripted fireball bot (weakest of the gate bots)', [0.8, 0.9])
    const yes = { ...base, versions: [ladder(0.62)] } as unknown as Registry
    const no = { ...base, versions: [ladder(0.48)] } as unknown as Registry
    expect(strengthLine(yes, 'champion')).toContain('also beats Hard head to head')
    expect(strengthLine(no, 'champion')).not.toContain('head to head')
    expect(strengthLine(yes, 'hard')).not.toContain('head to head')
  })

  test('Champion has no action cap, so its explainer says its delay is the only handicap', () => {
    expect(limitsExplainer(130, null)).not.toMatch(/\bcap\b|at most/i)
    expect(limitsExplainer(130, null)).toContain('130 ms late')
    expect(limitsExplainer(200, 90)).toContain('at most 90 actions a minute')
  })
})

describe('a Practice level states only the loop result the last test measured (LC1)', () => {
  const practice = (reason: string | undefined) => reg({ levels: {}, measured: {}, unpublished: reason ? { hard: reason } : {} } as Partial<Registry>)

  test('reads seat results and the Hard ladder failure', () => {
    const r = practice('in training: fireball25 on seat 1: 210 wins, 2 draws of 400, Wilson lower bound 0.4 is below 0.6; champion does not beat hard: score 0.4 over 400 games')
    expect(practiceResult(r, 'hard')).toContain('won 210 and drew 2 of 400 games')
    expect(practiceResult(r, 'hard')).toContain('did not beat Hard')
  })

  test('names each bot it lost to with the counts from the registry', () => {
    const r = practice('in training: throwloop: 253 of 400, Wilson lower bound 0.5842 is below 0.6; throwtap: 235 of 400, Wilson lower bound 0.5386 is below 0.6')
    expect(practiceResult(r, 'hard')).toBe('Last test: it beat the bot that repeatedly throws in 253 of 400 games and the throw-tap bot in 235 of 400 games. The results did not clear the confidence threshold for publication.')
  })

  test('says nothing when no result was recorded, and nothing for a published level', () => {
    expect(practiceResult(practice('in training: no snapshot cleared the scripted-bot gate during training, so hard is not published.'), 'hard')).toBeNull()
    expect(practiceResult(practice(undefined), 'hard')).toBeNull()
    expect(practiceResult(reg({}), 'hard')).toBeNull()
    expect(practiceResult(null, 'hard')).toBeNull()
  })
})
