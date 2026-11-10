import { describe, expect, test } from 'bun:test'
import type { Registry } from '@duelwise/agents/src/registry'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { LEVEL_MALLET } from '@duelwise/core/src/games/puck/constants'
import registryA from '@duelwise/agents/registry/puck.json'
import registryB from '@duelwise/agents/eval/puck/outcome-B/puck.json'
import { parseRegistry } from '@duelwise/agents/src/registry'
import { PRACTICE_COPY, agentCard, limitsText, practiceResult, resultReason, strengthLine } from './strength'

const measured = { metric: 'score vs scripted banker bot (weakest of the gate bots)', value: 0.7, ci95: [0.62, 0.8], n: 400, opponents: 'o', siteElo: 1200, measuredAt: '2026-11-10T09:00:00.000Z', harness: 'bun', commit: 'c' }
const reg = (over: Partial<Registry> = {}): Registry =>
  ({
    game: 'puck',
    champion: 'v1',
    versions: [],
    levels: { easy: { version: 'v1', config: {} }, hard: { version: 'v1', config: {} } },
    measured: { hard: measured },
    unpublished: {},
    learnsFromHumans: false,
    ...over,
  }) as unknown as Registry

describe('Glasscut strength copy', () => {
  test('a level that is not published reads In training, with its recorded reason and no strength or Elo number', () => {
    expect(strengthLine(reg(), 'champion')).toBe(PRACTICE_COPY)
    expect(strengthLine(null, 'medium')).toBe(PRACTICE_COPY)
    expect(PRACTICE_COPY).toMatch(/^In training/)
    const r = reg({ unpublished: { champion: 'in training: banker: 235 of 400, Wilson lower bound 0.5400 on seat 1 is below 0.75' } })
    const why = practiceResult(r, 'champion')
    expect(why).toContain('235 of 400 against the bank-shot bot')
    expect(why).not.toMatch(/elo/i)
    expect(practiceResult(reg(), 'hard')).toBeNull()
    expect(practiceResult(reg(), 'medium')).toBeNull()
  })

  test('a published level says its reaction delay and mallet speed in plain words, and what it was measured against', () => {
    const line = strengthLine(reg(), 'hard')
    expect(line).toBe('Beats our test bots in at least 6 of 10 games, including the bank-shot bot; not yet measured against people.')
    expect(line).not.toMatch(/elo|unbeatable|win rate/i)
    const limits = limitsText('hard')
    expect(limits).toContain(`${Math.round((LEVEL_LIMITS.puck.hard.delayFrames * 1000) / 60)} ms`)
    expect(limits).toContain(`${LEVEL_MALLET.hard.speed} table widths a second`)
  })

  test('the limits sentence is built from the level config, so Sable is never called capped below the rule speed', () => {
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      expect(limitsText(level)).toContain(`${Math.round((LEVEL_LIMITS.puck[level].delayFrames * 1000) / 60)} ms`)
    }
    expect(limitsText('champion')).toMatch(/as fast as yours/i)
    expect(limitsText('easy')).not.toMatch(/as fast as yours/i)
  })

  test('the style line is absent while a level is In training (no Vesper network exists yet) and present for a published level', () => {
    expect(agentCard(reg(), 'medium').training).toBe(true)
    expect(agentCard(reg(), 'medium').style).toBeNull()
    expect(agentCard(reg(), 'champion').style).toBeNull()
    const published = agentCard(reg(), 'hard')
    expect(published.training).toBe(false)
    expect(published.style).toEqual(expect.any(String))
    expect(agentCard(reg({ measured: { easy: measured, hard: measured } } as never), 'easy').style).toMatch(/hand-written, not trained/i)
  })

  test('the agent card carries the persona name, the level label, and In training for an unpublished level', () => {
    const c = agentCard(reg(), 'medium')
    expect(c.title).toBe('Marlow, Medium')
    expect(c.training).toBe(true)
    expect(c.strength).toBe(PRACTICE_COPY)
    expect(agentCard(reg(), 'hard').training).toBe(false)
  })
})

describe('the Last test line for a level in training, from the real registries', () => {
  const A = parseRegistry(registryA)
  const B = parseRegistry(registryB)
  // The live registry is outcome A until scripts/apply-puck-outcome-b.sh runs; the A cases then skip and the B cases cover it.
  const isA = !Object.hasOwn(A.measured, 'champion')

  test.skipIf(!isA)('Sable, outcome A: one short clause per bot (its worst seat), no repeated bot, no threshold sentence, and the live-view reason named', () => {
    const why = practiceResult(A, 'champion')!
    expect(why).toBe(
      'Last test: it won 0 of 400 against the rush bot, 0 of 400 against the goalie bot, 1 of 400 against the bank-shot bot and 0 of 400 against the shadow bot. ' +
        'Those bots see the live puck with no reaction delay; Sable reacts at 150 ms.',
    )
    expect(why).not.toMatch(/confidence threshold/i)
    expect(why.match(/the rush bot/g)).toHaveLength(1)
  })

  test.skipIf(!isA)('Marlow, a near miss (lower bound .8978 against a bar of .90): says how close, and keeps the threshold sentence', () => {
    const why = practiceResult(A, 'medium')!
    expect(why).toBe('Last test: it beat the random bot in 371 of 400 games, just short of the bar. That did not clear the confidence threshold for publication.')
  })

  test('the card quotes a Last test only for a level that plays the measured network: Marlow yes, Sable no under A', () => {
    if (isA) {
      expect(agentCard(A, 'medium').why).toContain('371 of 400')
      expect(agentCard(A, 'champion').why).toBeNull()
      expect(agentCard(A, 'champion').training).toBe(true)
    }
    expect(agentCard(B, 'champion').why).toBeNull()
    expect(agentCard(B, 'champion').training).toBe(false)
    expect(agentCard(B, 'medium').why).toContain('371 of 400')
  })
})

describe('Glasscut result reason', () => {
  test('says how the match ended in plain words and does not repeat the score the result chip shows', () => {
    expect(resultReason({ winner: 0, score: [7, 0], reason: 'goals' })).toBe('First to 7')
    expect(resultReason({ winner: 1, score: [3, 5], reason: 'time' })).toBe('Time was up')
    expect(resultReason({ winner: 0, score: [4, 3], reason: 'sudden' })).toBe('Level at time, the next goal won it')
    expect(resultReason({ winner: null, score: [2, 2], reason: 'draw' })).toBe('Still level at the hard cap')
    for (const reason of ['goals', 'time', 'sudden', 'draw'] as const) expect(resultReason({ winner: 0, score: [7, 4], reason })).not.toMatch(/\d+ to \d+/)
  })
})

describe('cards under the human-hands registry (Nov 10)', () => {
  test('Hard and Champion say the test bots had your mallet; an unpublished Pip is called a script', async () => {
    const { parseRegistry } = await import('@duelwise/agents/src/registry')
    const raw = (await import('../../../../../packages/agents/eval/puck/human-hands/puck.json')).default
    const reg = parseRegistry(raw as never)
    const { agentCard } = await import('./strength')
    expect(agentCard(reg, 'hard').strength).toContain('whose mallets are as fast as yours')
    expect(agentCard(reg, 'champion').strength).toContain('whose mallets are as fast as yours')
    expect(agentCard(reg, 'easy').strength).toBe('In training: a simple script for learning the controls; it has not passed our strength test.')
    expect(agentCard(reg, 'easy').why).toBeNull()
  })
})
