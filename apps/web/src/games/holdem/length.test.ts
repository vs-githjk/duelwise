import { expect, test } from 'bun:test'
import { DEFAULT_CHOICE, LENGTH_CHOICES, STORAGE_KEY, optionsFor, readChoice, saveChoice } from './length'

const fake = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

test('every choice maps to the options the core takes', () => {
  expect(optionsFor('5')).toEqual({ hands: 5, untilBust: true })
  expect(optionsFor('10')).toEqual({ hands: 10, untilBust: true })
  expect(optionsFor('15')).toEqual({ hands: 15, untilBust: true })
  expect(optionsFor('30')).toEqual({ untilBust: true })
  expect(LENGTH_CHOICES.map((c) => c.id)).toEqual(['5', '10', '15', '30'])
})

test('a practice match has no bust ending: its options carry only the length', () => {
  expect(optionsFor('5', true)).toEqual({ hands: 5 })
  expect(optionsFor('15', true)).toEqual({ hands: 15 })
  expect(optionsFor('30', true)).toEqual({})
  expect(optionsFor('5', false)).toEqual({ hands: 5, untilBust: true })
})

test('the default is 10 hands and the last choice is remembered', () => {
  expect(DEFAULT_CHOICE).toBe('10')
  expect(readChoice(fake())).toBe('10')
  const s = fake()
  saveChoice('30', s)
  expect(readChoice(s)).toBe('30')
  // A value from the earlier "until someone busts" pick is no longer offered.
  expect(readChoice(fake({ [STORAGE_KEY]: 'bust' }))).toBe('10')
  expect(readChoice(fake({ [STORAGE_KEY]: '15' }))).toBe('15')
})

test('junk, missing and throwing storage fall back to the default', () => {
  expect(readChoice(fake({ [STORAGE_KEY]: '99' }))).toBe('10')
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  expect(readChoice(broken)).toBe('10')
  expect(() => saveChoice('5', broken)).not.toThrow()
  expect(readChoice(null)).toBe('10')
})
