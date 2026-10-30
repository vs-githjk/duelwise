import { expect, test } from 'bun:test'
import { parseCards } from '@duelwise/core/src/games/holdem/cards'
import { categoryWords, fullHandName, handStrength } from './strength'

test('preflop describes the hole cards', () => {
  expect(handStrength(parseCards('As Ah'), [])).toBe('Your hand: pocket pair')
  expect(handStrength(parseCards('As Ks'), [])).toBe('Your hand: two suited cards')
  expect(handStrength(parseCards('As Kd'), [])).toBe('Your hand: two unpaired cards')
})

test('after the flop it names the best hand', () => {
  expect(handStrength(parseCards('As Kd'), parseCards('2c 7d 9h'))).toBe('Your hand: a high card')
  expect(handStrength(parseCards('As Kd'), parseCards('Ac 7d 9h'))).toBe('Your hand: a pair')
  expect(categoryWords(parseCards('9s 9d'), parseCards('9c 4d 4h Ks 2c'))).toBe('a full house')
  expect(categoryWords(parseCards('As Ks'), parseCards('2s 7s 9s Kd 3c'))).toBe('a flush')
})

test('a finished hand is named with its ranks', () => {
  const name = (hole: string, board: string) => fullHandName(parseCards(hole), parseCards(board))
  expect(name('Ks 5d', 'Kc 5h 9d 2c 3s')).toBe('two pair, kings and fives')
  expect(name('Ks 7d', 'Kc 5h 9d 2c 3s')).toBe('a pair of kings, nine kicker')
  expect(name('As Ad', 'Ac 5h 9d 2c 3s')).toBe('three aces')
  expect(name('9s 9d', 'Kc 4d 4h Ks 2c')).toBe('two pair, kings and nines')
  expect(name('9s 9d', '9c 4d 4h Ks 2c')).toBe('a full house, nines over fours')
  expect(name('7s 7d', '7c 7h 4h Ks 2c')).toBe('four sevens')
  expect(name('As Ks', '2s 7s 9s Kd 3c')).toBe('a flush, ace high')
  expect(name('5s 4d', '3c 2h Ad 9s Kc')).toBe('a straight, five high')
  expect(name('Ts Js', 'Qs Ks As 2d 3c')).toBe('a royal flush')
  expect(name('9s 8s', '7s 6s 5s Ad 3c')).toBe('a straight flush, nine high')
  expect(name('As Kd', '2c 7d 9h 4s 3c')).toBe('ace high')
  expect(name('6s 6d', '6c 2h 9d Kc 3s')).toBe('three sixes')
})
