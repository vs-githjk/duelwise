import { describe, expect, test } from 'bun:test'
import { PRODUCT, type GameId } from './product'
import { isSealed, SEALED_GAMES } from './sealed'

describe('sealed games', () => {
  test('word, fleet and penalty are sealed, every other current game is not', () => {
    expect(SEALED_GAMES).toEqual(['word', 'fleet', 'penalty'])
    expect(isSealed('word')).toBe(true)
    expect(isSealed('fleet')).toBe(true)
    expect(isSealed('penalty')).toBe(true)
    for (const g of Object.keys(PRODUCT.games) as GameId[]) if (g !== 'word' && g !== 'fleet' && g !== 'penalty') expect(isSealed(g)).toBe(false)
  })
})
