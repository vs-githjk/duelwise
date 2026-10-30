import { describe, expect, test } from 'bun:test'
import { fourCore } from '@duelwise/core/src/games/four/core'
import type { FourState } from '@duelwise/core/src/games/four/rules'
import type { Seat } from '@duelwise/core/src/types'
import { showPracticeBadge, winningCells, winningLines } from './useFourMatch'

function play(moves: string): FourState {
  let s = fourCore.init(0)
  for (const ch of moves) {
    const seat = fourCore.toAct(s)[0] as Seat
    s = fourCore.step(s, seat === 0 ? [Number(ch), null] : [null, Number(ch)])
  }
  return s
}

describe('winningLines', () => {
  test('a double win yields one line per run, each ending on its own cells', () => {
    const s = play('2036056643613504453603505526214')
    expect(s.winner).toBe(0)
    const lines = winningLines(s)
    expect(lines).toHaveLength(2)
    expect(lines).toContainEqual({ from: [2, 1], to: [5, 4] })
    expect(lines).toContainEqual({ from: [3, 3], to: [6, 3] })
    const cells = winningCells(s)
    for (const l of lines) {
      expect(cells.has(`${l.from[0]},${l.from[1]}`)).toBe(true)
      expect(cells.has(`${l.to[0]},${l.to[1]}`)).toBe(true)
    }
    expect(cells.has('4,2')).toBe(false) // the old single line passed through here
  })

  test('no winner means no lines', () => {
    expect(winningLines(play('0123'))).toEqual([])
    expect(winningCells(play('0123')).size).toBe(0)
  })
})

describe('showPracticeBadge', () => {
  test('a published level never flashes Practice while its agent is still starting', () => {
    // The hook's agent preview flag starts true; before the agent exists it says nothing about the level.
    expect(showPracticeBadge('starting', true, false)).toBe(false)
  })
  test('an unpublished level is Practice from the start, and a stub agent on a published level is Practice once made', () => {
    expect(showPracticeBadge('starting', true, true)).toBe(true)
    expect(showPracticeBadge('playing', true, false)).toBe(true)
    expect(showPracticeBadge('over', false, true)).toBe(true)
  })
  test('a real agent on a published level carries no badge, and the setup screen none at all', () => {
    expect(showPracticeBadge('playing', false, false)).toBe(false)
    expect(showPracticeBadge('over', false, false)).toBe(false)
    expect(showPracticeBadge('setup', true, true)).toBe(false)
  })
})
