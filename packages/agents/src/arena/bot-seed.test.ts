import { expect, test } from 'bun:test'
import { arenaBotSeed } from './bot-seed'

test('measurement bot seeds match the training environment for both seats and bot kinds', () => {
  expect(arenaBotSeed(100, 0, 'holder')).toBe(100 + 104729 + 2)
  expect(arenaBotSeed(100, 1, 'peeker')).toBe(100 + 2 * 104729 + 3)
})
