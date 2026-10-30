import { expect, test } from 'bun:test'
import { deltaPoints, measuredText, pct, shortDate, signed, playerMetric } from './format'

test('internal bot names and gate descriptions do not reach players', () => {
  expect(playerMetric('score vs scripted pokeloop bot (weakest seat of the weakest gate bot)')).toBe('score against a test opponent')
  expect(playerMetric('average guesses over every answer word')).toBe('average guesses over every answer word')
})

test('rates read as percentages and other metrics as plain numbers', () => {
  expect(measuredText('score vs random legal play', 0.8125)).toBe(pct(0.8125))
  expect(measuredText('average guesses over every answer word', 4.546647)).toBe('4.55')
})

test('change in points needs games on both sides', () => {
  expect(deltaPoints({ games: 10, wins: 3 }, { games: 10, wins: 4 })).toBe(-10)
  expect(deltaPoints({ games: 0, wins: 0 }, { games: 10, wins: 4 })).toBeNull()
  expect(signed(0)).toBe('0')
  expect(signed(-2)).toBe('-2')
  expect(signed(3)).toBe('+3')
})

test('dates are UTC and survive junk', () => {
  expect(shortDate('2026-10-21T23:59:59Z')).toBe('Oct 21')
  expect(shortDate('nope')).toBe('')
})
