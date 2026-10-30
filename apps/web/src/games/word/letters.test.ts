import { describe, expect, test } from 'bun:test'
import { feedback } from '@duelwise/core/src/games/word/feedback'
import { letterStates } from './letters'

const rows = (words: string[], answer: string) => words.map((w) => Array.from(feedback(w, answer)))

describe('letter tracker', () => {
  test('is empty before any guess', () => {
    expect(letterStates([], [])).toEqual({ placed: [], elsewhere: [], out: [] })
  })

  test('sorts letters alphabetically into placed, elsewhere and ruled out', () => {
    // answer crane: slate -> s out, l out, a right? (a is index 2 in slate, index 2 in crane) placed, t out, e placed
    const g = ['slate']
    expect(letterStates(g, rows(g, 'crane'))).toEqual({ placed: ['a', 'e'], elsewhere: [], out: ['l', 's', 't'] })
  })

  test('a letter found in the word is never also ruled out, and the best marker wins', () => {
    // answer crane. 'eerie' has e at 0 (elsewhere), e at 1 (absent: only one e), r (elsewhere), i (out), e at 4 (placed).
    const g = ['eerie', 'cargo']
    const s = letterStates(g, rows(g, 'crane'))
    expect(s.placed).toContain('e')
    expect(s.out).not.toContain('e')
    expect(s.out).toContain('i')
    // c is placed, a elsewhere, r elsewhere, g and o out.
    expect(s.placed).toEqual(['c', 'e'])
    expect(s.elsewhere).toEqual(['a', 'r'])
    expect(s.out).toEqual(['g', 'i', 'o'])
  })

  test('a letter appears once even when guessed several times', () => {
    const g = ['mamma', 'mummy']
    const s = letterStates(g, rows(g, 'crane'))
    expect(s).toEqual({ placed: [], elsewhere: ['a'], out: ['m', 'u', 'y'] })
  })
})
