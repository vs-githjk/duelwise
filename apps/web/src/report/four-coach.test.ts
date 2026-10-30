import { describe, expect, test } from 'bun:test'
import { fourFromMoves } from '@duelwise/core/src/games/four/rules'
import { buildReportBody } from './build'
import { coachFour, forcedWin } from './four-coach'
import { playScript } from './testing'

describe('four coaching without the solver', () => {
  test('an early loss with a missed block still gets a "you could have played column N" moment', () => {
    // The AI stacks column 4 three high; the human, with no threat of its own, plays column 5 instead of blocking.
    const rec = playScript('four', 1, [0, 3, 1, 3, 2, 3, 4, 3], 0)
    expect(rec.actions.length).toBe(8)
    const r = buildReportBody(rec)
    const m = r.moments.find((x) => /could have played column/i.test(x.text))
    expect(m).toBeDefined()
    expect(m!.text).toBe('You could have played column 4. Column 4 would have blocked Marlow\'s four in a row.')
    expect(m!.publicText).toBe('The player could have played column 4. Column 4 would have blocked Marlow\'s four in a row.')
    expect(m!.label).toBe('Drop 7: column 5')
    expect(r.moments.at(-1)!.kind).toBe('end')
  })

  test('names a win that was missed', () => {
    const r = buildReportBody(playScript('four', 1, [0, 3, 0, 3, 0, 3, 1, 3], 0))
    const m = r.moments.find((x) => /could have played column/i.test(x.text))
    expect(m!.text).toBe('You could have played column 1. It made four in a row.')
  })

  test('coachFour reports the move index, the kind and the better columns', () => {
    const c = coachFour([0, 1, 0, 1, 0, 2, 3], 0)
    expect(c).toEqual({ index: 6, played: 3, better: [0], kind: 'win' })
  })

  test('forcedWin finds a double threat and nothing on an empty board', () => {
    expect(forcedWin(fourFromMoves([]), 3)).toBe(false)
    // seat 0 has stones in columns 1,2,3 on the bottom row (open both ends); it is seat 0 to move? n=6 -> seat 0.
    const open = fourFromMoves([1, 6, 2, 6, 3, 5])
    expect(forcedWin(open, 1)).toBe(true)
  })

  test('a human win gets no coaching', () => {
    expect(coachFour([0, 1, 0, 1, 0, 1, 0], 0)).toBeNull()
  })
})
