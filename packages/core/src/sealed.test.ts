import { describe, expect, test } from 'bun:test'
import { PRODUCT, type GameId } from './product'
import { isSealed, SEALED_GAMES } from './sealed'

describe('sealed games', () => {
  test('word is sealed, every other current game is not', () => {
    expect(SEALED_GAMES).toEqual(['word'])
    expect(isSealed('word')).toBe(true)
    for (const g of Object.keys(PRODUCT.games) as GameId[]) if (g !== 'word') expect(isSealed(g)).toBe(false)
  })
})
