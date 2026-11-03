import { expect, test } from 'bun:test'
import { chipText, drawsOwnOfflinePill, isUnratedOfflinePath } from './OfflineChip'
import { isRatedLive, setRatedLive, subscribeRatedLive } from '../lib/match-active'

test('the chip says what is true: Stormglass setup is Practice only, a live rated Stormglass match is reconnecting, every other page keeps its line', () => {
  expect(chipText(true, false)).toBe('Offline: Practice only')
  expect(chipText(true, true)).toBe('Offline: reconnecting')
  expect(chipText(false, false)).toBe('Offline: matches will sync later')
  // A rated flag left over can never change another page's wording.
  expect(chipText(false, true)).toBe('Offline: matches will sync later')
})

test('the rated-live flag notifies and clears', () => {
  let calls = 0
  const off = subscribeRatedLive(() => calls++)
  expect(isRatedLive()).toBe(false)
  setRatedLive(true)
  setRatedLive(true)
  expect(isRatedLive()).toBe(true)
  setRatedLive(false)
  expect(isRatedLive()).toBe(false)
  expect(calls).toBe(2)
  off()
})

test('Stormglass and Crosscurrent draw their own pill in the page; every other page keeps the fixed chip', () => {
  expect(drawsOwnOfflinePill('/play/stormglass')).toBe(true)
  expect(drawsOwnOfflinePill('/play/crosscurrent')).toBe(true)
  expect(drawsOwnOfflinePill('/play/crosscurrent/')).toBe(true)
  for (const p of ['/play/chess', '/play/four-in-a-row', '/play/word-duel', '/play', '/', '/dev/fleet']) expect(drawsOwnOfflinePill(p)).toBe(false)
})

test('chess, Four in a Row and Hold\'em say their offline matches are not counted; other pages keep their line', () => {
  expect(chipText(false, false, true)).toBe('Offline: matches are not counted')
  expect(chipText(false, false, false)).toBe('Offline: matches will sync later')
  for (const p of ['/play/chess', '/play/four-in-a-row', '/play/heads-up-holdem', '/play/chess/']) expect(isUnratedOfflinePath(p), p).toBe(true)
  for (const p of ['/play', '/play/crosscurrent', '/play/word-duel', '/', '/play/tinderbox']) expect(isUnratedOfflinePath(p), p).toBe(false)
})
