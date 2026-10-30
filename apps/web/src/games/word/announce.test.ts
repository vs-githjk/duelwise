import { describe, expect, test } from 'bun:test'
import { roundAnnouncement } from './announce'

describe('round announcement for screen readers', () => {
  test('is empty before the first guess', () => {
    expect(roundAnnouncement({ mine: [], myRows: [], oppName: 'Pip', oppRows: [], max: 6 })).toBe('')
  })

  test('says each letter of your latest guess, then how far the opponent got', () => {
    const text = roundAnnouncement({ mine: ['crane'], myRows: [[0, 1, 2, 0, 2]], oppName: 'Pip', oppRows: [[2, 2, 0, 0, 0]], max: 6 })
    expect(text).toBe('Round 1 of 6. You guessed CRANE: C not in the word, R in the word but the wrong spot, A in the right spot, N not in the word, E in the right spot. Pip: 2 of 5 letters in the right spot in its best row.')
  })

  test('announces a solve by either side, and a loss of the race, in words', () => {
    expect(roundAnnouncement({ mine: ['crane'], myRows: [[2, 2, 2, 2, 2]], oppName: 'Pip', oppRows: [[0, 0, 0, 0, 0]], max: 6 })).toContain('You solved the word.')
    const lost = roundAnnouncement({ mine: ['crane'], myRows: [[0, 0, 0, 0, 0]], oppName: 'Pip', oppRows: [[2, 2, 2, 2, 2]], max: 6 })
    expect(lost).toContain('Pip solved the word.')
    expect(lost).not.toContain('in its best row')
  })

  test('uses the latest round only and the opponent best row so far', () => {
    const text = roundAnnouncement({ mine: ['crane', 'slate'], myRows: [[0, 0, 0, 0, 0], [0, 0, 2, 0, 2]], oppName: 'Pip', oppRows: [[2, 2, 2, 0, 0], [2, 0, 0, 0, 0]], max: 6 })
    expect(text.startsWith('Round 2 of 6. You guessed SLATE:')).toBe(true)
    expect(text).toContain('3 of 5 letters')
  })
})
