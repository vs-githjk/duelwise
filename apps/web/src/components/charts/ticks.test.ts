import { expect, test } from 'bun:test'
import { shownLabelIndexes } from './ticks'

test('every label shows when there is room', () => {
  expect(shownLabelIndexes(8, 700, 56)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
})

test('labels are thinned to keep a minimum gap, anchored on the newest point', () => {
  const idx = shownLabelIndexes(8, 300, 56)
  expect(idx).toEqual([1, 3, 5, 7])
  const step = 300 / 7
  for (let i = 1; i < idx.length; i++) expect((idx[i]! - idx[i - 1]!) * step).toBeGreaterThanOrEqual(56)
})

test('degenerate inputs never throw', () => {
  expect(shownLabelIndexes(0, 300, 56)).toEqual([])
  expect(shownLabelIndexes(1, 300, 56)).toEqual([0])
  expect(shownLabelIndexes(5, 0, 56)).toEqual([4])
})
