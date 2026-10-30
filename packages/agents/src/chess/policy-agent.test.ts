import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { makeRng } from '@duelwise/core/src/rng'
import { createGameAgent, CHESS_LEVELS } from './agent'
import { movePolicy, sampleIndex } from './policy-agent'

const MODELS = join(import.meta.dir, '../../../../apps/web/public/agents/chess/v1')

describe('move policy', () => {
  const logits = Float32Array.from({ length: 10 }, (_, i) => (i === 3 ? 2 : i === 7 ? 1 : 0))
  test('temperature 0 puts everything on the most likely legal move', () => {
    expect(Array.from(movePolicy(logits, [1, 7, 3, 9], 0))).toEqual([0, 0, 1, 0])
    // An illegal move with a huge logit is never chosen: only the listed indices count.
    expect(Array.from(movePolicy(Float32Array.from([9, 1, 2]), [1, 2], 0))).toEqual([0, 1])
  })
  test('temperature 1 is a softmax over the legal moves and a lower temperature is sharper', () => {
    const p1 = movePolicy(logits, [3, 7, 0], 1)
    expect(p1.reduce((a, b) => a + b)).toBeCloseTo(1, 10)
    expect(p1[0]!).toBeCloseTo(Math.exp(2) / (Math.exp(2) + Math.exp(1) + 1), 10)
    const p03 = movePolicy(logits, [3, 7, 0], 0.3)
    expect(p03[0]!).toBeGreaterThan(p1[0]!)
  })
  test('sampling follows the probabilities and is fixed by the seed', () => {
    const p = Float64Array.from([0.1, 0.7, 0.2])
    const draw = (seed: number) => {
      const rng = makeRng(seed)
      return Array.from({ length: 4000 }, () => sampleIndex(p, rng))
    }
    expect(draw(5)).toEqual(draw(5))
    const counts = [0, 0, 0]
    for (const i of draw(5)) counts[i]!++
    expect(counts[1]! / 4000).toBeGreaterThan(0.66)
    expect(counts[1]! / 4000).toBeLessThan(0.74)
    expect(sampleIndex(Float64Array.from([0, 0, 1]), makeRng(1))).toBe(2)
  })
})

describe('move policy with a logit margin', () => {
  const logits = Float32Array.from([2, 1.8, 1.2, 0, 0, 0])
  test('only moves within the margin of the best can be drawn, weighted by softmax, even at temperature 0', () => {
    const p = movePolicy(logits, [0, 1, 2, 3], 0, 0.5)
    expect(p[2]!).toBe(0)
    expect(p[3]!).toBe(0)
    expect(p[0]! + p[1]!).toBeCloseTo(1, 10)
    expect(p[0]!).toBeCloseTo(1 / (1 + Math.exp(-0.2)), 6)
    expect(p[1]!).toBeGreaterThan(0)
  })
  test('a margin of 0 or unset keeps the old behaviour', () => {
    expect(Array.from(movePolicy(logits, [0, 1, 2], 0, 0))).toEqual([1, 0, 0])
    expect(Array.from(movePolicy(logits, [0, 1, 2], 0))).toEqual([1, 0, 0])
  })
  test('the best move always survives a tiny margin', () => {
    expect(Array.from(movePolicy(logits, [2, 1], 0, 1e-9))).toEqual([0, 1])
  })
})

describe('chess agents', () => {
  test('the Champion plays a legal move within its node budget and reports preview false', async () => {
    const a = await createGameAgent('champion', { search: { nodeBudget: 3000, timeCapMs: undefined }, ttBits: 16, seat: 0 })
    expect(a.preview).toBe(false)
    a.reset(1)
    const s = chessCore.init(1)
    const [code] = await a.act(chessCore.observe(s, 0), s)
    expect(chessCore.legal(s, 0)).toContain(chessCore.decodeAction(code!))
    a.dispose()
  })

  for (const level of ['easy', 'medium', 'hard'] as const) {
    const file = join(MODELS, `policy-${CHESS_LEVELS[level].band}.onnx`)
    test(`${level}: a published policy net plays legal moves for both colours; without the file it is a preview`, async () => {
      const a = await createGameAgent(level, { seat: 1 })
      expect(a.preview).toBe(!existsSync(file))
      if (a.preview) return a.dispose() // the stub is covered by agent-dispatch.test.ts
      a.reset(3)
      let s = chessCore.init(3)
      for (let ply = 0; ply < 12 && !chessCore.terminal(s); ply++) {
        const seat = chessCore.toAct(s)[0]!
        const [code] = await a.act(chessCore.observe(s, seat), s)
        const uci = chessCore.decodeAction(code!)
        expect(chessCore.legal(s, seat)).toContain(uci)
        s = chessCore.step(s, seat === 0 ? [uci, null] : [null, uci])
      }
      a.dispose()
    })
  }
})

describe.if(existsSync(join(MODELS, 'policy-b1900.onnx')))('Hard varies with the seed', () => {
  test('against one fixed opponent line, 5 seeds do not all play the same game', async () => {
    const games: string[] = []
    for (let seed = 1; seed <= 5; seed++) {
      const a = await createGameAgent('hard', { seat: 1 })
      a.reset(seed)
      let s = chessCore.init(0)
      const moves: string[] = []
      for (let ply = 0; ply < 24 && !chessCore.terminal(s); ply++) {
        const seat = chessCore.toAct(s)[0]!
        let uci: string
        if (seat === 0) uci = [...chessCore.legal(s, 0)].sort()[0]! // a fixed, seed-free opponent
        else uci = chessCore.decodeAction((await a.act(chessCore.observe(s, 1), s))[0]!)
        moves.push(uci)
        s = chessCore.step(s, seat === 0 ? [uci, null] : [null, uci])
      }
      games.push(moves.join(' '))
      a.dispose()
    }
    expect(new Set(games).size).toBeGreaterThan(1)
  })
})
