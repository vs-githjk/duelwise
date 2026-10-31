import { expect, test } from 'bun:test'
import type { HandSummary } from '@duelwise/core/src/games/holdem/match'
import { readFileSync } from 'node:fs'
import { humanBusted } from './useHoldemMatch'

const hand = (delta: number): HandSummary => ({ hand: 0, winner: delta > 0 ? 0 : delta < 0 ? 1 : null, delta, pot: Math.abs(delta) * 2, showdown: true, board: [], hole: null })

test('a bust is a hand that took all 100 of the human\'s chips', () => {
  expect(humanBusted(hand(-100), 0)).toBe(true)
  expect(humanBusted(hand(-99), 0)).toBe(false)
  expect(humanBusted(hand(-6), 0)).toBe(false)
  expect(humanBusted(hand(0), 0)).toBe(false)
})

test('winning all 100 is not the human\'s bust', () => {
  expect(humanBusted(hand(100), 0)).toBe(false)
})

test('the human in the other seat reads the same hand the other way round', () => {
  expect(humanBusted(hand(100), 1)).toBe(true)
  expect(humanBusted(hand(-100), 1)).toBe(false)
})

// The e2e (practice.spec.ts) proves it in the browser; this keeps the cause out of the source: the loss stinger belongs to the match result.
test('the loss sound is played from the match result only, never from a bust that the match goes on after', () => {
  const src = readFileSync(new URL('./useHoldemMatch.ts', import.meta.url), 'utf8')
  const calls = [...src.matchAll(/playCue\(\s*r\.winner === null \? 'draw' : r\.winner === HUMAN \? 'win' : 'lose'|playCue\('lose'/g)]
  expect(calls).toHaveLength(1)
  const conclude = src.slice(src.indexOf('const conclude = '), src.indexOf('const apply = '))
  expect(conclude).toContain("'lose'")
  expect(src.slice(src.indexOf('const apply = '))).not.toContain("'lose'")
})
