import { expect, test } from 'bun:test'
import { PRODUCT } from './product'

test('tagline is exact', () => {
  expect(PRODUCT.tagline).toBe('Six games. Learning from you, starting with Four in a Row. Beat them if you can.')
})

test('six games with display name and slug, no enabled flag', () => {
  const ids = Object.keys(PRODUCT.games).sort()
  expect(ids).toEqual(['arena', 'chess', 'fighter', 'four', 'holdem', 'word'])
  for (const g of Object.values(PRODUCT.games)) {
    expect(g.displayName.length).toBeGreaterThan(0)
    expect(g.slug).toMatch(/^[a-z0-9-]+$/)
    expect('enabled' in g).toBe(false)
  }
  expect(PRODUCT.games.chess.displayName).toBe('Chess')
  expect(PRODUCT.games.four.displayName).toBe('Four in a Row')
  expect(PRODUCT.games.holdem.displayName).toBe("Heads-Up Hold'em")
  expect(PRODUCT.games.word.displayName).toBe('Word Duel')
})

test('name never matches the rejected name', () => {
  expect(PRODUCT.name).not.toMatch(/beat\s*me/i)
  expect(PRODUCT.name).toBe('Duelwise')
})

test('champion delay is locked to 3 within 2..4', () => {
  expect(PRODUCT.championMinDelayFrames).toBe(3)
  expect(PRODUCT.championMinDelayFrames).toBeGreaterThanOrEqual(2)
  expect(PRODUCT.championMinDelayFrames).toBeLessThanOrEqual(4)
})

test('training data basis is legitimate-interest', () => {
  expect(PRODUCT.trainingDataBasis).toBe('legitimate-interest')
})

test('slugs are unique', () => {
  const slugs = Object.values(PRODUCT.games).map((g) => g.slug)
  expect(new Set(slugs).size).toBe(slugs.length)
})
