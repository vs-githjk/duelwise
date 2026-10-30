import { expect, test } from 'bun:test'
import { parseCards } from '@duelwise/core/src/games/holdem/cards'
import type { HandSummary } from '@duelwise/core/src/games/holdem/match'
import { describeAction, describeHand } from './describe'
import { historyLine, historyCards } from './HandHistory'
import { visibleOpponentCards } from './Table'

test('showdown cards are visible throughout the all in runout', () => {
  expect(visibleOpponentCards(showdown)).toEqual(showdown.hole![1])
  expect(visibleOpponentCards({ ...showdown, showdown: false, hole: null })).toEqual([null, null])
})

test('a raise on an empty street is a bet, and an all-in is named as one', () => {
  expect(describeAction(0, { type: 'raise', to: 2 }, 0, 'Pip', { open: true, allIn: false })).toBe('You bet 2')
  expect(describeAction(1, { type: 'raise', to: 2 }, 0, 'Pip', { open: true, allIn: false })).toBe('Pip bets 2')
  expect(describeAction(1, { type: 'raise', to: 7 }, 1, 'Pip', { open: false, allIn: false })).toBe('Pip raises to 7')
  expect(describeAction(0, { type: 'raise', to: 100 }, 0, 'Pip', { open: false, allIn: true })).toBe('You go all in to 100')
  expect(describeAction(1, { type: 'raise', to: 100 }, 0, 'Pip', { open: true, allIn: true })).toBe('Pip goes all in to 100')
  expect(describeAction(0, { type: 'call' }, 0, 'Pip')).toBe('You check')
})

const showdown: HandSummary = {
  hand: 0,
  winner: 0,
  delta: 12,
  pot: 24,
  showdown: true,
  board: parseCards('Kc 5h 9d 2c 3s'),
  hole: [parseCards('Ks 5d'), parseCards('Ad Qd')],
}

test('the showdown banner names the full hand', () => {
  expect(describeHand(showdown, 'Pip')).toBe('You win 12 at showdown with two pair, kings and fives')
  expect(describeHand({ ...showdown, winner: 1, delta: -12, hole: [parseCards('2s 7d'), parseCards('Ks 5d')] }, 'Pip')).toBe('Pip wins 12 at showdown with two pair, kings and fives')
})

test('history rows say whose cards are whose', () => {
  expect(historyLine(showdown, 'Pip')).toBe('You won 12, at showdown')
  expect(historyCards(showdown, 'Pip')).toBe('You K♠ 5♦, Pip A♦ Q♦, board K♣ 5♥ 9♦ 2♣ 3♠')
  expect(historyCards({ ...showdown, showdown: false, hole: null }, 'Pip')).toBeNull()
})
