import { expect, test } from 'bun:test'
import { nextMatchEpoch, trackBeganOffline, type BeganOfflineState } from './began-offline'

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

test('the match epoch moves on only when a shown result goes away', () => {
  let s = { epoch: 0, hadResult: false }
  s = nextMatchEpoch(s, false)
  expect(s.epoch).toBe(0)
  s = nextMatchEpoch(s, true)
  expect(s.epoch).toBe(0)
  s = nextMatchEpoch(s, true)
  expect(s.epoch).toBe(0)
  s = nextMatchEpoch(s, false)
  expect(s.epoch).toBe(1)
  expect(nextMatchEpoch(s, false).epoch).toBe(1)
})
