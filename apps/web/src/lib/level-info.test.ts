import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Level } from '@duelwise/core/src/product'
import { inTrainingCopy } from './level-info'
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
