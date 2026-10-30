import { expect, test } from 'bun:test'
import { wordGainTag, wordGuessCopy } from './word'

test('word report names the opponent and shows remaining words', () => {
  const copy = wordGuessCopy('SLATE', 106, 32, 1, 'Pip')
  expect(copy.text).toContain('Pip had 32 words')
  expect(copy.value).toBe('106 left')
})

test('a guess after one answer remains is not described as narrowing', () => {
  expect(wordGuessCopy('APPLE', 1, 1, 2, 'Pip', 1).text).toContain('already only one word')
})

test('least helpful requires a clear gap and more than one word remaining', () => {
  expect(wordGainTag(2, 10, 5)).toBe('least helpful')
  expect(wordGainTag(4, 5, 5)).toBe('smallest gain')
  expect(wordGainTag(0, 10, 1)).toBe('smallest gain')
})
