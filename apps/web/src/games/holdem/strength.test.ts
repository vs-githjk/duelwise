import { expect, test } from 'bun:test'
import { parseCards } from '@duelwise/core/src/games/holdem/cards'
import { categoryWords, fullHandName, handStrength } from './strength'

test('preflop describes the hole cards', () => {
  expect(handStrength(parseCards('As Ah'), [])).toBe('Your hand: pocket pair')
  expect(handStrength(parseCards('As Ks'), [])).toBe('Your hand: two suited cards')
  expect(handStrength(parseCards('As Kd'), [])).toBe('Your hand: two unpaired cards')
})

test('after the flop it names the best hand', () => {
  expect(handStrength(parseCards('As Kd'), parseCards('2c 7d 9h'))).toBe('Your hand: ace high')
  expect(handStrength(parseCards('As Kd'), parseCards('Ac 7d 9h'))).toBe('Your hand: a pair of aces')
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

test('the label says which ranks are shared with the opponent', () => {
  const label = (hole: string, board: string) => handStrength(parseCards(hole), parseCards(board), 'Pip')
  // The exact play-test case: 2d 4c on Ks Ah Ac is just the board pair, then a 4 makes two pair.
  expect(label('2d 4c', 'Ks Ah Ac')).toBe('Your hand: a pair of aces, on the table, so Pip has it too')
  expect(label('2d 4c', 'Ks Ah Ac 4d')).toBe('Your hand: two pair, aces and fours (the aces are on the table, Pip shares them)')
  // Pocket pair: not shared.
  expect(label('9s 9d', 'Ks 2h 5c')).toBe('Your hand: a pair of nines')
  // One hole card pairs the board: not shared.
  expect(label('Ks 3d', 'Kc 8h 5c')).toBe('Your hand: a pair of kings')
  // Pocket pair under a board pair: the board pair is shared, the pocket pair is not.
  expect(label('4s 4d', 'Ah Ac Ks')).toBe('Your hand: two pair, aces and fours (the aces are on the table, Pip shares them)')
  // Two pair made entirely from the board.
  expect(label('2s 3d', 'Ah Ac Ks Kd 9c')).toBe('Your hand: two pair, aces and kings, on the table, so Pip has it too')
  // Trips: one on the table is not shared, all three are.
  expect(label('As Ad', 'Ac 5h 9d')).toBe('Your hand: three aces')
  expect(label('2s 3d', 'Ac Ah Ad 9d')).toBe('Your hand: three aces, on the table, so Pip has it too')
  // Full house: trips on the board, pair from the hand.
  expect(label('9s 9d', 'Ac Ah Ad 4d')).toBe('Your hand: a full house, aces over nines (the aces are on the table, Pip shares them)')
  // Straight and flush: shared only when the board alone makes them.
  expect(label('As Kd', '2c 3h 4d 5s 6c')).toBe('Your hand: a straight, six high, on the table, so Pip has it too')
  expect(label('Ad 9c', '2c 3h 4d 5s Kc')).toBe('Your hand: a straight, five high')
  expect(label('Ac 4d', '2s 7s 9s Ks 3s')).toBe('Your hand: a flush, king high, on the table, so Pip has it too')
  expect(label('As 5d', '2s 7s 9s Ks 3c')).toBe('Your hand: a flush, ace high')
  // A high card is just named.
  expect(label('As Kd', '2c 7d 9h')).toBe('Your hand: ace high')
  // Default opponent wording.
  expect(handStrength(parseCards('2d 4c'), parseCards('Ks Ah Ac'))).toBe('Your hand: a pair of aces, on the table, so your opponent has it too')
})
