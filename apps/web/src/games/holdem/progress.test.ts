import { expect, test } from 'bun:test'
import type { HandSummary } from '@duelwise/core/src/games/holdem/match'
import { progressNumbers } from './progress'

const summary = (hand: number, delta: number): HandSummary => ({ hand, winner: delta > 0 ? 0 : 1, delta, pot: Math.abs(delta) * 2, showdown: true, board: [], hole: null })

test('before the pot is pushed the header still shows the hand that is on the table and the chips before it', () => {
  // The core has already moved on: hand index 4 finished (5 on screen), the state says hand 5 (6 on screen) and net 12 after a win of 8.
  const state = { hand: 5, net: [12, -12] as [number, number] }
  for (const stage of ['runout', 'show'] as const) {
    expect(progressNumbers(state, { stage, summary: summary(4, 8) })).toEqual({ hand: 5, net: 4 })
  }
})

test('after the push, and with no reveal, the header shows the state', () => {
  const state = { hand: 5, net: [12, -12] as [number, number] }
  expect(progressNumbers(state, { stage: 'push', summary: summary(4, 8) })).toEqual({ hand: 6, net: 12 })
  expect(progressNumbers(state, null)).toEqual({ hand: 6, net: 12 })
})

test('a loss is added back, not subtracted, before the push', () => {
  expect(progressNumbers({ hand: 1, net: [-6, 6] }, { stage: 'show', summary: summary(0, -6) })).toEqual({ hand: 1, net: 0 })
})

test('the history labels say whose chips moved', async () => {
  const { deltaWords } = await import('./progress')
  expect(deltaWords(8)).toBe('You gained 8 chips')
  expect(deltaWords(-6)).toBe('You lost 6 chips')
  expect(deltaWords(0)).toBe('No chips changed hands')
})
