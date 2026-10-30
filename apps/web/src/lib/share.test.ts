import { expect, test } from 'bun:test'
import { marginOf, shareText, type ShareFacts } from './share'

const d = new Date(2026, 9, 29)
const win: ShareFacts = { game: 'word', level: 'medium', call: 'hard', result: { winner: 0, score: [1, 0], reason: 'solved first' }, humanSeat: 0, humanMoves: 4, rank: { place: 14, of: 212 }, date: d, host: 'duelwise.app' }

test('a win is three lines with the call, the margin and the rank', () => {
  expect(shareText(win)).toBe('Duelwise Word Duel, Oct 29\nCalled Vesper. Beat Marlow in 4 guesses. #14 of 212.\nduelwise.app/c/word-duel/vesper')
})
test('a loss has no rank and says who took it; no call drops the first sentence', () => {
  const loss = { ...win, result: { winner: 1 as const, score: [0, 1] as [number, number], reason: 'solved first' }, rank: null }
  expect(shareText(loss)).toBe('Duelwise Word Duel, Oct 29\nCalled Vesper. Marlow took it in 4 guesses.\nduelwise.app/c/word-duel/vesper')
  expect(shareText({ ...loss, call: null }).split('\n')[1]).toBe('Marlow took it in 4 guesses.')
})
test('margins in each unit and no dashes anywhere', () => {
  expect(marginOf({ game: 'chess', result: win.result, humanSeat: 0, humanMoves: 31 })).toBe('31 moves')
  expect(marginOf({ game: 'arena', result: { winner: 0, score: [7, 5], reason: 'rounds' }, humanSeat: 0, humanMoves: 0 })).toBe('7 rounds to 5')
  expect(marginOf({ game: 'holdem', result: { winner: 0, score: [0, 0], reason: 'ahead by 340 chips after 20 hands' }, humanSeat: 0, humanMoves: 0 })).toBe('340 chips after 20 hands')
  expect(marginOf({ game: 'holdem', result: { winner: 0, score: [0, 0], reason: 'fold' }, humanSeat: 0, humanMoves: 0 })).toBeNull()
  expect(/[\u2013\u2014]/.test(shareText(win))).toBe(false)
})
