import { describe, expect, test } from 'bun:test'
import { pathNote } from './PathCard'

describe('pathNote', () => {
  test('a rated path says how to unlock the next opponent', () => {
    expect(pathNote('chess', false)).toBe('Clear Pip to unlock Marlow, then Vesper, then Sable.')
  })
  test('practice opens every opponent, so the card does not promise a lock', () => {
    expect(pathNote('chess', true)).toBe('Practice opens every opponent. Only rated wins clear a stop.')
  })
  test('a game with no rated matches yet (RATED_NOT_OPEN) says so, in practice or not', () => {
    for (const practice of [true, false]) {
      expect(pathNote('puck', practice)).toBe('Glasscut has no rated matches yet, so every opponent is open as practice.')
    }
  })
})
