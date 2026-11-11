import { describe, expect, test } from 'bun:test'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { fourFromMoves, stoneAt } from '@duelwise/core/src/games/four/rules'
import { slackCore } from '@duelwise/core/src/games/slack/core'
import { fleetCore } from '@duelwise/core/src/games/fleet'
import { penaltyCore } from '@duelwise/core/src/games/penalty/core'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { absoluteCells, chessMoveBetween as chessMove, fourStateFromObs, newStone, slackMoveBetween as slackMove } from './remote-logic'

describe('what a remote page rebuilds from one seat view', () => {
  test('Four: the board from either seat shows the same stones, winner and heights', () => {
    const s = fourFromMoves([3, 4, 3, 4, 3, 4, 3])
    for (const seat of [0, 1] as const) {
      const rebuilt = fourStateFromObs(fourCore.observe(s, seat))
      expect(rebuilt.n).toBe(7)
      expect(rebuilt.h).toEqual(s.h)
      expect(rebuilt.winner).toBe(0)
      for (let c = 0; c < 7; c++) for (let r = 0; r < 6; r++) expect(stoneAt(rebuilt, c, r)).toBe(stoneAt(s, c, r))
    }
  })

  test('Four: the new stone is found, a skipped reconnect or a first view shows none', () => {
    const a = fourCore.observe(fourFromMoves([3]), 1).cells
    const b = fourCore.observe(fourFromMoves([3, 3]), 1).cells
    const c = fourCore.observe(fourFromMoves([3, 3, 4, 4]), 1).cells
    expect(newStone(a, b, 1)).toEqual({ col: 3, row: 1, seat: 1 })
    expect(newStone(null, b, 1)).toBeNull()
    expect(newStone(a, c, 1)).toBeNull()
  })

  test('Crosscurrent: absolute cells agree for both seats, and the move between two boards names the disc and the flips', () => {
    const s0 = slackCore.init(0)
    const move = slackCore.legal(s0, 0)[0]!
    const s1 = slackCore.step(s0, [move, null])
    for (const seat of [0, 1] as const) {
      expect(absoluteCells(slackCore.observe(s1, seat))).toEqual(s1.cells)
    }
    const m = slackMove(absoluteCells(slackCore.observe(s0, 1)), absoluteCells(slackCore.observe(s1, 1)))
    expect(m?.cell).toBe(move)
    expect(m?.seat).toBe(0)
    expect(m?.flips.length).toBeGreaterThan(0)
    expect(slackMove(null, s1.cells)).toBeNull()
  })

  test('Chess: the move between two positions is found, and a gap of two moves is not guessed', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    const two = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'
    expect(chessMove(start, after)).toEqual({ last: { from: 'e2', to: 'e4' }, san: 'e4' })
    expect(chessMove(start, two)).toBeNull()
  })

  test('the hidden games: one seat view holds nothing of the other seat', () => {
    // Word: the other seat's marker rows only, never its letters; the answer only at the end.
    let w = wordCore.init(7, { answer: 'crane' } as never)
    w = wordCore.step(w, ['jumpy', 'slate'])
    const wa = wordCore.observe(w, 0)
    expect(JSON.stringify(wa)).not.toContain('slate')
    expect(wa.answer).toBeNull()
    // Stormglass: before the end a seat has no `reveal` and sees only its own ships.
    const f = fleetCore.init(11)
    const fa = fleetCore.observe(f, 0)
    const fb = fleetCore.observe(f, 1)
    expect(fa.reveal).toBeNull()
    expect(fa.sunk).toEqual([])
    expect(fb.ships).toEqual([])
    // Twelve Yards: a view carries finished kicks and no pick of the kick in progress.
    const p = penaltyCore.init(5)
    const pa = penaltyCore.observe(p, 0)
    expect(pa.kicks).toEqual([])
    expect(Object.keys(pa).sort()).toEqual(['goals', 'kicks', 'over', 'role', 'round', 'seat', 'sudden', 'taken'])
  })
})
