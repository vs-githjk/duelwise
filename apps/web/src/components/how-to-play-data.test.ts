import { describe, expect, test } from 'bun:test'
import { guides, hasSeenGuide, markGuideSeen, storageKey } from './how-to-play-data'
import type { GameId } from '@duelwise/core/src/product'

describe('how to play', () => {
  test('each game has instructions and controls', () => {
    for (const game of ['chess', 'four', 'holdem', 'word', 'fighter', 'arena', 'fleet', 'slack'] as GameId[]) {
      const guide = guides[game]
      expect(guide.goal).toBeTruthy()
      expect(guide.steps.length).toBeGreaterThanOrEqual(3)
      expect(guide.steps.length).toBeLessThanOrEqual(6)
      expect(guide.controls.length).toBeGreaterThan(0)
      expect(guide.controls.every((control) => control.keys && control.action)).toBe(true)
      expect(guide.win).toBeTruthy()
      expect(guide.tip).toBeTruthy()
    }
  })
  test('first visit is remembered per game', () => {
    const values = new Map<string, string>()
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) } })
    try {
      expect(hasSeenGuide('chess')).toBe(false)
      markGuideSeen('chess')
      expect(hasSeenGuide('chess')).toBe(true)
      expect(values.get(storageKey('chess'))).toBe('seen')
      expect(hasSeenGuide('four')).toBe(false)
    } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete (globalThis as { localStorage?: Storage }).localStorage }
  })
  test('blocked storage still remembers for this session', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked') } })
    try {
      expect(hasSeenGuide('word')).toBe(false)
      markGuideSeen('word')
      expect(hasSeenGuide('word')).toBe(true)
    } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete (globalThis as { localStorage?: Storage }).localStorage }
  })
})
