import { expect, test } from 'bun:test'
import { ROSTER, aiChoiceFor } from './roster'
import { CHARACTERS } from './render/characters'

test('the AI takes the other fighter and a colourway that differs from yours', () => {
  for (const character of [0, 1]) {
    for (const colorway of [0, 1, 2]) {
      const ai = aiChoiceFor({ character, colorway })
      expect(ai.character).toBe(1 - character)
      expect(ai.colorway).toBeLessThan(CHARACTERS[ai.character]!.colorways.length)
      expect(ai.colorway).toBeLessThan(ROSTER[ai.character]!.colorways.length)
          expect(ai.colorway).not.toBe(0) // the AI never takes the default look
    }
  }
})
