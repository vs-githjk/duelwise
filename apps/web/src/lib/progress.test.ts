import { beforeEach, expect, test } from 'bun:test'
import { calledFor, takeCall, writeCall } from './progress'

/** A tiny localStorage so progress.ts has a browser to read. */
function install(): void {
  const store = new Map<string, string>()
  const w = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  ;(globalThis as { window?: unknown }).window = w
}

beforeEach(install)

test('a player who tapped no call has none: takeCall is null and the result sheet has nothing to quote', () => {
  expect(takeCall('word')).toBeNull()
  expect(calledFor('word')).toBeNull()
})

test('a tapped call is used for the match, shown afterwards, and used up for the next one', () => {
  writeCall('word', 'hard')
  expect(takeCall('word')).toBe('hard')
  expect(calledFor('word')).toBe('hard')
  expect(takeCall('word')).toBeNull()
  expect(calledFor('word')).toBeNull()
})

import { nextUp } from './progress'
test('nextUp names the next opponent only for a player who has cleared something', () => {
  const none = { easy: false, medium: false, hard: false, champion: false }
  expect(nextUp(none)).toBeNull()
  expect(nextUp({ ...none, easy: true })).toBe('medium')
  expect(nextUp({ easy: true, medium: true, hard: false, champion: false })).toBe('hard')
  expect(nextUp({ easy: true, medium: true, hard: true, champion: true })).toBeNull()
})
