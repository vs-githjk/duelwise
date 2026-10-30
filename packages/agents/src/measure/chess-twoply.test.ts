import { describe, expect, test } from 'bun:test'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { decodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import { createGameAgent } from './chess-twoply'

const play = async (fen: string, seed: number): Promise<string> => {
  const a = await createGameAgent('hard', { seat: 1 })
  a.reset(seed)
  const s = chessCore.init(0, { fen })
  const [code] = await a.act(chessCore.observe(s, chessCore.toAct(s)[0]!), s)
  return decodeAbs(code!)
}

describe('the 2-ply material bot', () => {
  test('does not hang its queen to a pawn and takes a free piece', async () => {
    for (let seed = 0; seed < 10; seed++) {
      expect(['d2d5', 'd2b5']).not.toContain(await play('4k3/8/2p5/8/8/8/3Q4/4K3 w - - 0 1', seed))
      expect(await play('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1', seed)).toBe('d2d5')
    }
  })
  test('plays the same move for the same seed', async () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'
    expect(await play(fen, 4)).toBe(await play(fen, 4))
  })
})
