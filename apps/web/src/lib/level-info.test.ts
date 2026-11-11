import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { REAL_MIN_MATCHES as MEASURE_MIN_MATCHES, REAL_MIN_PLAYERS as MEASURE_MIN_PLAYERS } from '@duelwise/agents/src/measure/people'
import { REAL_MIN_MATCHES, REAL_MIN_PLAYERS } from './people-line'
import { inTrainingCopy, levelInfoFromRegistry, peopleLine } from './level-info'
import { PRACTICE_COPY } from '../games/fighter/strength'

test('a level whose snapshots never cleared the scripted-bot gate reads as Practice, not "still being measured"', () => {
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    expect(inTrainingCopy(level, `in training: no snapshot cleared the scripted-bot gate during training, so ${level} is not published.`)).toBe(PRACTICE_COPY)
  }
})

test('a completed confidence gate failure reads as Practice', () => {
  expect(inTrainingCopy('hard', 'in training: throwtap: 235 of 400, Wilson lower bound 0.5386 is below 0.6')).toBe(PRACTICE_COPY)
})

test('other reasons keep their plain sentences', () => {
  expect(inTrainingCopy('hard', 'hard does not beat medium')).toBe('Hard has not yet proven it beats Medium.')
  // The per-seat wording (a pair that clears the pooled bound but not every seat) reads the same to players.
  expect(inTrainingCopy('champion', "in training: champion does not beat hard from every seat: overall score 0.6188 over 400 games, 95% interval [0.5702, 0.6650], but seat 1 scored 0.5487 over 400 games, 95% interval [0.4998, 0.5968], and each seat's lower bound must be above 0.5")).toBe('Champion has not yet proven it beats Hard.')
  expect(inTrainingCopy('hard', 'something else')).toBe('Hard is still being measured.')
})

test('every unpublished reason in the real fighter and arena registries reads as Practice', () => {
  for (const game of ['fighter', 'arena']) {
    const reg = JSON.parse(readFileSync(new URL(`../../../../packages/agents/registry/${game}.json`, import.meta.url), 'utf8')) as {
      unpublished?: Record<string, string>
    }
    for (const [level, reason] of Object.entries(reg.unpublished ?? {})) {
      expect(inTrainingCopy(level as Level, reason)).toBe(PRACTICE_COPY)
    }
  }
})

test('boardPracticeLine: an In training column on a game with no rated path says matches are Practice and count nowhere', async () => {
  const { boardPracticeLine } = await import('./level-info')
  const puck = boardPracticeLine('puck', 'Marlow')
  expect(puck).toMatch(/Practice/)
  expect(puck).toMatch(/count/)
  expect(puck).not.toMatch(/counts on your own path/)
  expect(boardPracticeLine('chess', 'Marlow')).toBe('Marlow is in training until it is measured. A win here counts on your own path, not on the board.')
})

// A9, D10: no percentage against people on the site until a level has 100 real matches; a card may say "tuned to win about 7 in 10 against an average
// player in our tests" only where the people block shows the band was hit, and a level held under its band by luck may state its measured ceiling.
describe('what a level card says about winning (D10)', () => {
  const block = (verdict: 'in-band' | 'below' | 'above' | 'ceiling', calibrated: number) => ({ band: { low: 0.65, high: 0.75 }, calibrated, verdict }) as never
  test('a level in its band says tuned to win about N in 10 against an average player in our tests', () => {
    expect(peopleLine(block('in-band', 0.69))).toBe('Tuned to win about 7 in 10 against an average player in our tests.')
    expect(peopleLine(block('in-band', 0.54))).toBe('Tuned to win about 5 in 10 against an average player in our tests.')
    expect(peopleLine(block('in-band', 0.85))).toBe('Tuned to win about 8 or 9 in 10 against an average player in our tests.')
    expect(peopleLine(block('in-band', 0.99))).toBe('Tuned to win more than 9 in 10 against an average player in our tests.')
  })
  test('a luck ceiling is stated as a ceiling, not as a tuned level', () => {
    const line = peopleLine(block('ceiling', 0.57))!
    expect(line).toBe('In our tests it wins about 6 in 10 against an average player, the most we could tune it to.')
    expect(line).not.toMatch(/tuned to win/i)
  })
  test('Chess shows no people line on any level until real matches reach 40 and 10 players (ruling 303)', () => {
    const chess = JSON.parse(readFileSync(new URL('../../../../packages/agents/registry/chess.json', import.meta.url), 'utf8')) as Registry
    const info = levelInfoFromRegistry(chess)
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) expect(info[level].people, `chess ${level}`).toBeUndefined()
    expect(chess.measured.champion?.people?.verdict).toBe('in-band') // the block is in band, so only the hide rule keeps the line away
    const inBand = { band: { low: 0.93, high: 1 }, calibrated: 0.99, verdict: 'in-band' }
    expect(peopleLine(inBand as never, 'chess')).toBeUndefined()
    expect(peopleLine({ ...inBand, real: { n: 39, players: 12, value: 0.99 } } as never, 'chess')).toBeUndefined()
    expect(peopleLine({ ...inBand, real: { n: 60, players: 9, value: 0.99 } } as never, 'chess')).toBeUndefined()
    expect(peopleLine({ ...inBand, real: { n: 40, players: 10, value: 0.99 } } as never, 'chess')).toContain('Tuned to win')
    expect(peopleLine(inBand as never, 'four')).toContain('Tuned to win')
  })
  test('the web copy of the real-data bars equals the measure module\'s', () => {
    expect([REAL_MIN_MATCHES, REAL_MIN_PLAYERS]).toEqual([MEASURE_MIN_MATCHES, MEASURE_MIN_PLAYERS])
  })
  test('a level off its band, or with no people block, says nothing about winning', () => {
    expect(peopleLine(block('below', 0.4))).toBeUndefined()
    expect(peopleLine(block('above', 0.9))).toBeUndefined()
    expect(peopleLine(undefined)).toBeUndefined()
  })
  test('no registry level produces a percentage or a claim against real people, and only band-hit or ceiling levels say anything', () => {
    for (const game of ['chess', 'four', 'holdem', 'word', 'fleet', 'slack', 'penalty', 'fighter', 'arena', 'puck']) {
      const reg = JSON.parse(readFileSync(new URL(`../../../../packages/agents/registry/${game}.json`, import.meta.url), 'utf8')) as Registry
      const info = levelInfoFromRegistry(reg)
      for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
        const line = info[level].people
        const people = reg.measured[level]?.people
        if (line === undefined) continue
        expect(reg.levels[level], `${game} ${level} says something about winning but is not published`).toBeDefined()
        expect(people?.verdict === 'in-band' || people?.verdict === 'ceiling').toBe(true)
        expect(line).not.toMatch(/%|percent|against people|real (players|matches)|unbeatable|never loses/i)
        expect(line).toMatch(/in 10 against an average player/)
      }
    }
  })
})
