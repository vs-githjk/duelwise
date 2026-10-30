import { describe, expect, test } from 'bun:test'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { Board, moveToUci } from './board'
import { createGameAgent } from './agent'
import { loadModelBytes } from './model-files'
import { nonRepeatingMoves } from './repetition'
import { ValueNet } from './value-eval'

const net = new ValueNet(await loadModelBytes('value.bin'))

/** White (Qa1, Kg6) against a lone king that shuffles g8-h8; white to move on the 4th position, where Qa2-a1 repeats the first. */
function shuffle(fen = '7k/8/6K1/8/8/8/8/Q7 b - - 0 1', moves = ['h8g8', 'a1a2', 'g8h8']) {
  let s = chessCore.init(0, { fen })
  for (const m of moves) s = chessCore.step(s, chessCore.toAct(s)[0] === 0 ? [m, null] : [null, m])
  return s
}

describe('nonRepeatingMoves', () => {
  const s = shuffle()
  const board = Board.fromFen(s.fen)
  const legal = board.legalMoves()
  const prior = s.keys.slice(0, -1)

  test('the repeating move is there to be dropped: a2a1 recreates the first position', () => {
    expect(s.keys[0]).toBe(chessCore.step(s, ['a2a1', null]).keys.at(-1)!)
    expect(legal.map(moveToUci)).toContain('a2a1')
  })

  test('a clearly winning side to move loses exactly the repeating move', () => {
    expect(net.evaluate(board)).toBeGreaterThan(1)
    const kept = nonRepeatingMoves(board, legal, prior, net).map(moveToUci)
    expect(kept).not.toContain('a2a1')
    expect(kept.length).toBe(legal.length - 1)
    expect(board.sq.join()).toBe(Board.fromFen(s.fen).sq.join()) // board left as it was
  })

  test('nothing is dropped when not ahead, without a net or without history', () => {
    const level = Board.fromFen('4k3/8/8/8/8/8/8/4K2R b - - 0 1')
    const lm = level.legalMoves()
    const keys = [chessCore.init(0, { fen: '4k3/8/8/8/8/8/8/4K2R b - - 0 1' }).keys[0]!]
    expect(nonRepeatingMoves(level, lm, keys, net, 99)).toEqual(lm)
    expect(nonRepeatingMoves(board, legal, prior, undefined)).toEqual(legal)
    expect(nonRepeatingMoves(board, legal, [], net)).toEqual(legal)
  })

  test('when every legal move repeats, all are kept', () => {
    const only = legal.filter((m) => moveToUci(m) === 'a2a1')
    expect(nonRepeatingMoves(board, only, prior, net)).toEqual(only)
  })
})

describe('Easy, Medium and Hard when winning', () => {
  for (const level of ['easy', 'medium', 'hard'] as const) {
    test(`${level} never plays the repeating move from a won shuffle`, async () => {
      const a = await createGameAgent(level, { seat: 0 })
      if (a.preview) return a.dispose()
      const s = shuffle()
      // Without the filter Medium repeats at seed 182 (probed 0..999), so 200 seeds fail if the wiring breaks.
      for (let seed = 0; seed < (level === 'medium' ? 200 : 25); seed++) {
        a.reset(seed)
        const [code] = await a.act(chessCore.observe(s, 0), s)
        expect(chessCore.decodeAction(code!)).not.toBe('a2a1')
      }
      a.dispose()
    })
  }
})
