import { expect, test } from 'bun:test'
import { boardSummary, moveAnnouncement } from './announce'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

test('the start position lists every piece for both sides, king first', () => {
  const s = boardSummary(START)
  expect(s.startsWith('White: king e1, queen d1, rook a1, rook h1')).toBe(true)
  expect(s).toContain('Black: king e8, queen d8')
  expect(s.match(/pawn/g)?.length).toBe(16)
})

test('checkmate names the last move and its player', () => {
  expect(moveAnnouncement({ opponent: 'Pip', plies: 4, lastSan: 'Qh4#', inCheck: true, over: true })).toBe('Pip played Qh4#. Checkmate.')
  expect(moveAnnouncement({ opponent: 'Pip', plies: 5, lastSan: 'Qxf7#', inCheck: true, over: true })).toBe('You played Qxf7#. Checkmate.')
})

test('a moved pawn is reported on its new square', () => {
  expect(boardSummary('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toContain('pawn e4')
})

test('the opponent move is announced with its notation and the prompt to move', () => {
  expect(moveAnnouncement({ opponent: 'Pip', plies: 2, lastSan: 'Nf6', inCheck: false, over: false })).toBe('Pip played Nf6. Your move.')
  expect(moveAnnouncement({ opponent: 'Pip', plies: 2, lastSan: 'Qh4+', inCheck: true, over: false })).toBe('Pip played Qh4+. Your move, you are in check.')
  expect(moveAnnouncement({ opponent: 'Pip', plies: 3, lastSan: 'e4', inCheck: false, over: false })).toBe('')
  expect(moveAnnouncement({ opponent: 'Pip', plies: 0, lastSan: undefined, inCheck: false, over: false })).toBe('Your move.')
  expect(moveAnnouncement({ opponent: 'Pip', plies: 9, lastSan: 'e4', inCheck: false, over: true })).toBe('Match over.')
})

test('announcements for a player who is Black: the opponent moves first and has just moved when the ply count is odd', () => {
  const black = { opponent: 'Pip', inCheck: false, over: false, humanSeat: 1 as const }
  expect(moveAnnouncement({ ...black, plies: 0, lastSan: undefined })).toBe('You are Black. Pip moves first.')
  expect(moveAnnouncement({ ...black, plies: 1, lastSan: 'e4' })).toBe('Pip played e4. Your move.')
  expect(moveAnnouncement({ ...black, plies: 2, lastSan: 'e5' })).toBe('')
  expect(moveAnnouncement({ ...black, plies: 3, lastSan: 'Qh5+', inCheck: true })).toBe('Pip played Qh5+. Your move, you are in check.')
  expect(moveAnnouncement({ ...black, plies: 6, lastSan: 'Qxf2#', over: true })).toBe('You played Qxf2#. Checkmate.')
  expect(moveAnnouncement({ ...black, plies: 5, lastSan: 'Qxf7#', over: true })).toBe('Pip played Qxf7#. Checkmate.')
})
