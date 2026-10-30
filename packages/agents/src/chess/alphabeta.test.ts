import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Chess } from 'chess.js'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { makeRng } from '@duelwise/core/src/rng'
import { Searcher, MATE, bestMove } from './alphabeta'
import { Board, moveToUci } from './board'
import { ValueNet } from './value-eval'

let net: ValueNet
beforeAll(async () => {
  net = new ValueNet(new Uint8Array(await Bun.file(join(import.meta.dir, '../../../../apps/web/public/agents/chess/v1/value.bin')).arrayBuffer()))
})

function perft(b: Board, depth: number): number {
  if (depth === 0) return 1
  const buf = new Int32Array(256)
  const n = b.generate(buf)
  let total = 0
  for (let i = 0; i < n; i++) {
    if (!b.make(buf[i]!)) continue
    // The generator reuses one buffer per call, so copy the loop state by recursing with a fresh buffer.
    total += depth === 1 ? 1 : perftDeep(b, depth - 1)
    b.unmake()
  }
  return total
}
function perftDeep(b: Board, depth: number): number {
  return perft(b, depth)
}

describe('move generator', () => {
  const cases: Array<[string, string, number[]]> = [
    ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
    ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['endgame with en passant pins', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['castling and promotion traps', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ]
  for (const [name, fen, counts] of cases) {
    test(`perft ${name}`, () => {
      counts.forEach((want, i) => expect(perft(Board.fromFen(fen), i + 1)).toBe(want))
    })
  }

  test('legal moves and incremental hash match the chess core along seeded games', () => {
    const rng = makeRng(99)
    let checked = 0
    for (let g = 0; g < 12; g++) {
      let s = chessCore.init(g)
      const b = Board.fromFen(s.fen)
      for (let ply = 0; ply < 140 && !chessCore.terminal(s); ply++) {
        const seat = chessCore.toAct(s)[0]!
        const legal = chessCore.legal(s, seat)
        expect(b.legalMoves().map(moveToUci).sort()).toEqual([...legal].sort())
        const fresh = Board.fromFen(s.fen)
        expect([b.hashLo, b.hashHi]).toEqual([fresh.hashLo, fresh.hashHi])
        const uci = legal[rng.int(legal.length)]!
        s = chessCore.step(s, seat === 0 ? [uci, null] : [null, uci])
        expect(b.make(b.parseUci(uci))).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  test('make then unmake restores the position exactly', () => {
    const b = Board.fromFen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1')
    const before = [Array.from(b.sq), b.hashLo, b.hashHi, b.castling, b.ep, b.halfmove, b.side]
    for (const m of b.legalMoves()) {
      b.make(m)
      b.unmake()
      expect([Array.from(b.sq), b.hashLo, b.hashHi, b.castling, b.ep, b.halfmove, b.side]).toEqual(before)
    }
  })
})

/** Brute force with chess.js, so the test positions do not rely on the engine under test. */
function mateIn1(c: Chess): string[] {
  return c.moves({ verbose: true }).filter((m) => { c.move(m); const mate = c.isCheckmate(); c.undo(); return mate }).map((m) => m.lan)
}
function forcedMateIn2(c: Chess): string[] {
  const out: string[] = []
  for (const first of c.moves({ verbose: true })) {
    c.move(first)
    let all = !c.isGameOver()
    if (all) {
      for (const reply of c.moves({ verbose: true })) {
        c.move(reply)
        if (mateIn1(c).length === 0) all = false
        c.undo()
        if (!all) break
      }
    }
    c.undo()
    if (all) out.push(first.lan)
  }
  return out
}

describe('search', () => {
  test('finds mate in 1 (position and answer verified with chess.js)', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'
    const answers = mateIn1(new Chess(fen))
    expect(answers).toEqual(['h5f7'])
    const r = bestMove(net, fen, { maxDepth: 4 })
    expect(r.uci).toBe('h5f7')
    expect(r.score).toBeGreaterThan(MATE - 10)
  })

  test('finds mate in 1 for black (fool\'s mate)', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2'
    expect(mateIn1(new Chess(fen))).toEqual(['d8h4'])
    expect(bestMove(net, fen, { maxDepth: 3 }).uci).toBe('d8h4')
  })

  test('finds mate in 2 (no mate in 1 exists, the first move is forced mate)', () => {
    const fen = 'r5k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1'
    const c = new Chess(fen)
    expect(mateIn1(c)).toEqual([])
    const firsts = forcedMateIn2(c)
    expect(firsts.length).toBeGreaterThan(0)
    const r = bestMove(net, fen, { maxDepth: 6 })
    expect(firsts).toContain(r.uci)
    expect(r.score).toBeGreaterThan(MATE - 10)
    expect(r.ended).toBe('mate')
  })

  test('avoids stalemate when it can win', () => {
    // White to move; Qb6 or Qc7 stalemates, Rh7+ wins. The search must not stalemate.
    const fen = '7k/8/5K2/8/8/8/8/1Q6 w - - 0 1'
    const r = bestMove(net, fen, { maxDepth: 5 })
    const c = new Chess(fen)
    c.move(r.uci.length === 4 ? { from: r.uci.slice(0, 2), to: r.uci.slice(2, 4) } : r.uci)
    expect(c.isStalemate()).toBe(false)
  })

  test('respects the time cap', () => {
    const fen = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 9'
    const s = new Searcher(net, 18)
    const t0 = performance.now()
    const r = s.search(fen, { timeCapMs: 300 })
    const wall = performance.now() - t0
    expect(wall).toBeLessThan(900)
    expect(r.depth).toBeGreaterThanOrEqual(1)
    expect(new Chess(fen).moves({ verbose: true }).map((m) => m.lan)).toContain(r.uci)
  })

  test('a node budget is deterministic and respected', () => {
    const fen = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 9'
    const a = bestMove(net, fen, { nodeBudget: 20000 })
    const b = bestMove(net, fen, { nodeBudget: 20000 })
    expect(a.uci).toBe(b.uci)
    expect(a.nodes).toBe(b.nodes)
    expect(a.nodes).toBeLessThan(21000)
    expect(a.ended).toBe('nodes')
  })

  test('returns the only legal move at once', () => {
    const fen = '7k/5q2/8/8/8/8/8/K5r1 w - - 0 1'
    expect(new Chess(fen).moves()).toEqual(['Kb2'])
    const r = bestMove(net, fen)
    expect(r.uci).toBe('a1b2')
    expect(r.ended).toBe('only-move')
  })

  test('scores the fifty-move rule as a draw and accepts earlier positions for repetition', () => {
    const winning = '7k/8/8/8/8/8/8/K6Q w - - 0 80'
    expect(bestMove(net, winning, { maxDepth: 3 }).score).toBeGreaterThan(0)
    // One move from the 100-half-move limit: every quiet reply ends the game as a draw.
    expect(Math.abs(bestMove(net, '7k/8/8/8/8/8/8/K6Q w - - 99 80', { maxDepth: 3 }).score)).toBe(0)
    expect(() => bestMove(net, winning, { maxDepth: 3, priorKeys: ['7k/8/8/8/8/8/8/K6Q w - -'] })).not.toThrow()
  })
})
