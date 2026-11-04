import { expect, test } from 'bun:test'
import { fourCore } from '@duelwise/core/src/games/four/core'
import type { FourState } from '@duelwise/core/src/games/four/rules'
import type { Seat } from '@duelwise/core/src/types'
import { boardSummary, columnLabel, dropAnnouncement } from './announce'

function play(moves: string): FourState {
  let s = fourCore.init(0)
  for (const ch of moves) {
    const seat = fourCore.toAct(s)[0] as Seat
    s = fourCore.step(s, seat === 0 ? [Number(ch), null] : [null, Number(ch)])
  }
  return s
}

test('a column states how many stones it holds and who owns the top one', () => {
  const s = play('33')
  expect(columnLabel(s, 3, 'Pip')).toBe("Column 4, 2 stones, top one is Pip's")
  expect(columnLabel(s, 0, 'Pip')).toBe('Column 1, empty')
  expect(columnLabel(play('3'), 3, 'Pip')).toBe('Column 4, 1 stone, top one is yours')
})

test('the board summary lists each column bottom to top', () => {
  expect(boardSummary(play('33'), 'Pip')).toContain('Column 4, bottom to top: you, Pip.')
  expect(boardSummary(play('33'), 'Pip')).toContain('Column 1: empty.')
})

test('the opponent drop is announced, the human drop is not', () => {
  expect(dropAnnouncement({ opponent: 'Pip', lastCol: 2, lastSeat: 1, moves: 2, over: false })).toBe('Pip dropped a stone in column 3. Your move.')
  expect(dropAnnouncement({ opponent: 'Pip', lastCol: 2, lastSeat: 0, moves: 1, over: false })).toBe('')
  expect(dropAnnouncement({ opponent: 'Pip', lastCol: null, lastSeat: null, moves: 0, over: false })).toBe('Your move.')
})

test('for a player who drops second, the ownership words and the prompts follow the seat', () => {
  // Seat 1 is the player: the first stone is the opponent's.
  const s = play('33')
  expect(columnLabel(s, 3, 'Pip', 1)).toBe("Column 4, 2 stones, top one is yours")
  expect(columnLabel(play('3'), 3, 'Pip', 1)).toBe("Column 4, 1 stone, top one is Pip's")
  expect(boardSummary(s, 'Pip', 1)).toContain('Column 4, bottom to top: Pip, you.')
  expect(dropAnnouncement({ opponent: 'Pip', lastCol: null, lastSeat: null, moves: 0, over: false, humanSeat: 1 })).toBe('You drop second. Pip opens.')
  expect(dropAnnouncement({ opponent: 'Pip', lastCol: 2, lastSeat: 0, moves: 1, over: false, humanSeat: 1 })).toBe('Pip dropped a stone in column 3. Your move.')
  expect(dropAnnouncement({ opponent: 'Pip', lastCol: 2, lastSeat: 1, moves: 2, over: false, humanSeat: 1 })).toBe('')
})
