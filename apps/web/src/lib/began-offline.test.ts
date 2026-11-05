import { expect, test } from 'bun:test'
import { nextMatchEpoch, trackBeganOffline, type BeganOfflineState, type MatchEpoch } from './began-offline'

const fresh: BeganOfflineState = { matchKey: 0, value: null }

test('a match that began offline stays offline for that match even after the connection returns', () => {
  const a = trackBeganOffline(fresh, { compact: true, offline: true, matchKey: 0 })
  expect(a.value).toBe(true)
  expect(trackBeganOffline(a, { compact: true, offline: false, matchKey: 0 }).value).toBe(true)
})

test('a match that began online is not flipped by losing the connection', () => {
  const a = trackBeganOffline(fresh, { compact: true, offline: false, matchKey: 0 })
  expect(trackBeganOffline(a, { compact: true, offline: true, matchKey: 0 }).value).toBe(false)
})

test('a rematch re-reads the connection: an offline start does not carry into the next match', () => {
  const first = trackBeganOffline(fresh, { compact: true, offline: true, matchKey: 0 })
  const rematch = trackBeganOffline(first, { compact: true, offline: false, matchKey: 1 })
  expect(rematch.value).toBe(false)
})

test('leaving the match line clears it', () => {
  const a = trackBeganOffline(fresh, { compact: true, offline: true, matchKey: 0 })
  expect(trackBeganOffline(a, { compact: false, offline: false, matchKey: 0 }).value).toBeNull()
})

test('the match epoch moves on when a shown result goes away', () => {
  let s: MatchEpoch = { epoch: 0, hadResult: false, wasActive: false }
  const step = (hasResult: boolean, matchActive = false) => (s = nextMatchEpoch(s, { hasResult, matchActive }))
  expect(step(false).epoch).toBe(0)
  expect(step(true).epoch).toBe(0)
  expect(step(true).epoch).toBe(0)
  expect(step(false).epoch).toBe(1)
  expect(step(false).epoch).toBe(1)
})

test('a page that reports only matchActive (Coldstore, Tinderbox) gets a new epoch for each rematch, not for a pause', () => {
  let s: MatchEpoch = { epoch: 0, hadResult: false, wasActive: false }
  const step = (matchActive: boolean) => (s = nextMatchEpoch(s, { hasResult: false, matchActive }))
  expect(step(true).epoch).toBe(1)
  expect(step(true).epoch, 'paused or hidden tab keeps matchActive true').toBe(1)
  expect(step(false).epoch, 'match over').toBe(1)
  expect(step(true).epoch, 'Play again').toBe(2)
})
