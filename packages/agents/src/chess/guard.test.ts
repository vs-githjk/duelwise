import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { decodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import { chessPlaneEncoder, PLANES } from '@duelwise/core/src/games/chess/encode'
import { relEncode } from '@duelwise/core/src/games/chess/policy-index'
import { CHESS_LEVELS, createGameAgent } from './agent'
import { loadModelBytes } from './model-files'
import { createPolicyAgent, movePolicy } from './policy-agent'
import { OrtSession } from '../runtime/ort-session'
import { Board, moveToUci } from './board'
import { findMateInOne, GUARD_NODE_BUDGET, lastGuardNodes, nucleus, safeMoves } from './guard'

// Nine positions with a mate in one for the side to move (both colours, rook, queen, knight, bishop-free corner cases).
const MATES: Array<[string, string]> = [
  ['6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8'],
  ['r3k3/8/8/8/8/8/5PPP/6K1 b - - 0 1', 'a8a1'],
  ['rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', 'd8h4'],
  ['r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'h5f7'],
  ['6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1', 'g5f7'],
  ['6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1', 'e1e8'],
  ['7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', 'f7g7'],
  ['8/8/8/8/8/5kq1/8/7K b - - 0 1', 'g3g2'],
  ['6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'd1d8'],
]

/** True when `uci` is legal in `fen` and leaves the opponent checkmated (some positions have more than one mate). */
function mates(fen: string, uci: string): boolean {
  const b = Board.fromFen(fen)
  const m = b.parseUci(uci)
  if (m < 0 || !b.make(m)) return false
  return b.inCheck() && b.legalMoves().length === 0
}

const MODELS = join(import.meta.dir, '../../../../apps/web/public/agents/chess/v1')
const haveNets = existsSync(join(MODELS, 'policy-b1100.onnx')) && existsSync(join(MODELS, 'policy-b1500.onnx'))

describe('mate in one guard', () => {
  for (const [fen, uci] of MATES) {
    test(`finds a mate (${uci}) in ${fen}`, () => {
      expect(mates(fen, uci)).toBe(true)
      const b = Board.fromFen(fen)
      const m = findMateInOne(b, b.legalMoves())
      expect(m).not.toBeNull()
      expect(mates(fen, moveToUci(m!))).toBe(true)
    })
  }
  test('returns null when no move mates, and leaves the board as it was', () => {
    const b = Board.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    const before = b.hashLo
    expect(findMateInOne(b, b.legalMoves())).toBeNull()
    expect(b.hashLo).toBe(before)
  })
})

describe('material guard (depth 2 plus quiescence)', () => {
  test('drops moves that hang the queen to a pawn and keeps the safe ones', () => {
    const b = Board.fromFen('4k3/8/2p5/8/8/8/3Q4/4K3 w - - 0 1')
    const kept = safeMoves(b, b.legalMoves(), 3).map(moveToUci)
    expect(kept).not.toContain('d2d5')
    expect(kept).not.toContain('d2b5')
    expect(kept).toContain('d2d3')
    expect(kept.length).toBeGreaterThan(5)
  })
  test('keeps every move when all of them lose the same material', () => {
    const b = Board.fromFen('6k1/8/8/8/8/8/5q2/7K w - - 0 1')
    expect(safeMoves(b, b.legalMoves(), 3).length).toBe(b.legalMoves().length)
  })
  test('a free capture of a hung queen is kept and the blunder next to it is dropped', () => {
    const b = Board.fromFen('4k3/8/8/3q4/4P3/8/8/3RK3 w - - 0 1')
    const kept = safeMoves(b, b.legalMoves(), 3).map(moveToUci)
    expect(kept).toContain('e4d5')
    expect(kept).not.toContain('d1d2')
  })
})

// Positions from the round-2 judge (chess-r2 mate-allowed.json) where the guard kept moves that allow mate in one.
const MATE_ALLOWED: Array<{ name: string; fen: string; saves: string[] }> = [
  { name: 'medium game 0', fen: '4rrk1/4bpp1/3p3p/1Rp5/5P2/2Q5/1PPP3P/1NB1K1R1 b - - 0 23', saves: ['d8', 'f6', 'g5', 'h4', 'f7f6', 'g7g6'] },
  { name: 'medium game 2 (Bb4+ is the only move that saves the game)', fen: '1kr2b1r/2p2qp1/BpQ1Np2/4P2p/4pP2/1R4P1/P1P4P/1NB1K2n b - - 0 26', saves: ['f8b4'] },
  { name: 'hard game 2', fen: '8/8/3R4/P2p4/1P1P3k/2P2K1P/8/8 b - - 2 47', saves: ['h4g5', 'h4h5'] },
]

/** True when the opponent has a reply to `m` that checkmates us. */
function allowsMateInOne(fen: string, m: number): boolean {
  const b = Board.fromFen(fen)
  b.make(m)
  const replies = b.legalMoves()
  let mate = false
  for (const r of replies) {
    b.make(r)
    if (b.inCheck() && b.legalMoves().length === 0) mate = true
    b.unmake()
    if (mate) break
  }
  return mate
}

describe('material guard sees mate against its own side', () => {
  for (const c of MATE_ALLOWED) {
    test(`${c.name}: no kept move allows mate in one`, () => {
      const b = Board.fromFen(c.fen)
      const legal = b.legalMoves()
      const safe = legal.filter((m) => !allowsMateInOne(c.fen, m))
      expect(safe.length).toBeGreaterThan(0) // the position has a way out
      const kept = safeMoves(b, legal, 3)
      expect(kept.length).toBeGreaterThan(0)
      for (const m of kept) expect(allowsMateInOne(c.fen, m)).toBe(false)
    })
  }
  test('medium game 2 keeps the checking move that blocks mate', () => {
    const b = Board.fromFen(MATE_ALLOWED[1]!.fen)
    expect(safeMoves(b, b.legalMoves(), 3).map(moveToUci)).toEqual(['f8b4'])
  })
})

describe('material guard cost and reference', () => {
  const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'
  test('Kiwipete finishes inside the node budget and still drops the losing moves', () => {
    const b = Board.fromFen(KIWIPETE)
    const legal = b.legalMoves()
    const before = b.hashLo
    const kept = safeMoves(b, legal, 3)
    expect(lastGuardNodes()).toBeLessThan(GUARD_NODE_BUDGET)
    expect(kept.map(moveToUci).sort()).toEqual(safeMoves(b, legal, 3, 1e12).map(moveToUci).sort())
    expect(b.hashLo).toBe(before)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(legal.length)
  })
  test('a tiny budget keeps the moves it did not get to check', () => {
    const b = Board.fromFen(KIWIPETE)
    const legal = b.legalMoves()
    expect(safeMoves(b, legal, 3, 50).length).toBeGreaterThan(safeMoves(b, legal, 3).length)
  })
  test('in a quiet position no move is dropped just for failing to win material', () => {
    const b = Board.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    expect(safeMoves(b, b.legalMoves(), 3).length).toBe(20)
  })
  test('a position that is already lost keeps the best moves rather than none', () => {
    const b = Board.fromFen('4k3/8/8/8/8/8/3q4/r3K3 w - - 0 1')
    expect(safeMoves(b, b.legalMoves(), 3).length).toBeGreaterThan(0)
  })
})

describe('nucleus', () => {
  test('keeps the smallest set of moves covering top-p mass and renormalises', () => {
    const p = nucleus(Float64Array.from([0.5, 0.3, 0.15, 0.05]), 0.8)
    expect(Array.from(p).map((x) => Math.round(x * 1000) / 1000)).toEqual([0.625, 0.375, 0, 0])
  })
  test('p of 1 changes nothing and the top move always survives', () => {
    const q = Float64Array.from([0.2, 0.8])
    expect(Array.from(nucleus(q, 1))).toEqual([0.2, 0.8])
    expect(Array.from(nucleus(q, 0.01))).toEqual([0, 1])
  })
})

describe.if(haveNets)('Easy and Medium with the real nets', () => {
  for (const level of ['easy', 'medium'] as const) {
    test(`${level} never misses a mate in one (9 positions x 6 seeds)`, async () => {
      const a = await createGameAgent(level, { seat: 0 })
      for (const [fen] of MATES) {
        for (let seed = 0; seed < 6; seed++) {
          a.reset(seed)
          const s = chessCore.init(0, { fen })
          const seat = chessCore.toAct(s)[0]!
          const [code] = await a.act(chessCore.observe(s, seat), s)
          expect(mates(fen, decodeAbs(code!))).toBe(true)
        }
      }
      a.dispose()
    })
  }
  test('Medium does not hang its queen in the probe position over 40 seeds', async () => {
    const a = await createGameAgent('medium', { seat: 0 })
    const fen = '4k3/8/2p5/8/8/8/3Q4/4K3 w - - 0 1'
    for (let seed = 0; seed < 40; seed++) {
      a.reset(seed)
      const s = chessCore.init(0, { fen })
      const [code] = await a.act(chessCore.observe(s, 0), s)
      expect(['d2d5', 'd2b5']).not.toContain(decodeAbs(code!))
    }
    a.dispose()
  })
  // The b1500 net's single most likely move here (rook to f2) hangs the rook to the king: a loss of 5 points.
  const HANG = '4r1k1/1pq1pp1p/p5p1/3B4/P4P2/1P1N2P1/2r4P/R4K2 b - - 0 25'
  test('the b1500 net on its own plays the hanging move, Medium (material guard) never does', async () => {
    const bytes = await loadModelBytes('policy-b1500.onnx')
    const raw = await createPolicyAgent({ band: 'b1500', temperature: 0 }, bytes, { seat: 1 })
    const s = chessCore.init(0, { fen: HANG })
    const [rawCode] = await raw.act(chessCore.observe(s, 1), s)
    expect(decodeAbs(rawCode!)).toBe('c2f2')
    raw.dispose()
    const a = await createGameAgent('medium', { seat: 1 })
    for (let seed = 0; seed < 40; seed++) {
      a.reset(seed)
      const [code] = await a.act(chessCore.observe(s, 1), s)
      expect(decodeAbs(code!)).not.toBe('c2f2')
    }
    a.dispose()
  })
  test('Easy never plays a move outside the 0.9 nucleus of the b1100 net (200 seeds)', async () => {
    const s = chessCore.init(0, { fen: HANG })
    const o = chessCore.observe(s, 1)
    const bytes = await loadModelBytes('policy-b1100.onnx')
    const session = await OrtSession.create(bytes)
    const planes = new Float32Array(PLANES * 64)
    chessPlaneEncoder.encode(o, planes, 0)
    const logits = (await session.run('input', planes, [1, PLANES, 8, 8]))['out0']!
    const board = Board.fromFen(HANG)
    const legal = board.legalMoves().map(moveToUci)
    const p = movePolicy(logits, legal.map((u) => relEncode(u, 'b')), CHESS_LEVELS.easy.temperature)
    const cut = nucleus(p, CHESS_LEVELS.easy.topP!)
    const inside = new Set(legal.filter((_, i) => cut[i]! > 0))
    const tail = p.reduce((sum, x, i) => (cut[i]! > 0 ? sum : sum + x), 0)
    // The test only bites when the cut removes real probability.
    expect(tail).toBeGreaterThan(0.05)
    expect(inside.size).toBeLessThan(legal.length)
    void session.dispose()
    const a = await createGameAgent('easy', { seat: 1 })
    for (let seed = 0; seed < 200; seed++) {
      a.reset(seed)
      const [code] = await a.act(o, s)
      expect(inside.has(decodeAbs(code!))).toBe(true)
    }
    a.dispose()
  })
})

// Six positions from the round-3 judge (chess-r3): the move the Hard or Medium agent played there. Four of them lose
// material inside the guard's depth-2 horizon and are dropped at margin 2 (kept at the old margin 3). The other two (b7b6,
// a5c6) lose nothing a depth-2 material search can see, so no margin catches them; they stay out of the dropped list.
const PROBES: Array<{ tag: string; fen: string; san: string; uci: string }> = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/judge-r3-probe-fens.json'), 'utf8'))
const DROPPED_AT_2 = ['hard:0:58', 'hard:1:28', 'hard:2:66', 'medium:2:40']

describe('guard margins on the round-3 judge positions', () => {
  test('Medium uses margin 2 and Hard margin 1 (R42: margin 2 let Hard score 0.49 against the 2-ply bot, margin 1 gives 0.715)', () => {
    expect(CHESS_LEVELS.medium.guardMargin).toBe(2)
    expect(CHESS_LEVELS.hard.guardMargin).toBe(1)
  })
  test('margin 1 only ever removes moves margin 2 kept, and never empties the list', () => {
    for (const p of PROBES) {
      const b = Board.fromFen(p.fen)
      const legal = b.legalMoves()
      const two = new Set(safeMoves(b, legal, 2).map(moveToUci))
      const one = safeMoves(b, legal, 1).map(moveToUci)
      expect(one.length).toBeGreaterThan(0)
      for (const u of one) expect(two.has(u)).toBe(true)
    }
  })
  test('the fixture holds the six judge positions and each played move is legal there', () => {
    expect(PROBES.map((p) => p.tag)).toHaveLength(6)
    for (const p of PROBES) expect(Board.fromFen(p.fen).legalMoves().map(moveToUci)).toContain(p.uci)
  })
  for (const p of PROBES.filter((x) => DROPPED_AT_2.includes(x.tag))) {
    test(`${p.tag}: ${p.san} is kept at margin 3 and dropped at margin 2`, () => {
      const b = Board.fromFen(p.fen)
      const legal = b.legalMoves()
      expect(safeMoves(b, legal, 3).map(moveToUci)).toContain(p.uci)
      const kept = safeMoves(b, legal, 2).map(moveToUci)
      expect(kept).not.toContain(p.uci)
      expect(kept.length).toBeGreaterThan(0)
    })
  }
  test('margin 2 only ever removes moves margin 3 kept', () => {
    for (const p of PROBES) {
      const b = Board.fromFen(p.fen)
      const legal = b.legalMoves()
      const three = new Set(safeMoves(b, legal, 3).map(moveToUci))
      for (const u of safeMoves(b, legal, 2).map(moveToUci)) expect(three.has(u)).toBe(true)
    }
  })
})

describe.if(haveNets)('Medium and Hard with the real nets on the judge positions', () => {
  for (const level of ['medium', 'hard'] as const) {
    test(`${level} never plays a dropped move (30 seeds)`, async () => {
      const a = await createGameAgent(level, { seat: 1 })
      for (const p of PROBES.filter((x) => DROPPED_AT_2.includes(x.tag))) {
        const s = chessCore.init(0, { fen: p.fen })
        const seat = chessCore.toAct(s)[0]!
        for (let seed = 0; seed < 30; seed++) {
          a.reset(seed)
          const [code] = await a.act(chessCore.observe(s, seat), s)
          expect(decodeAbs(code!)).not.toBe(p.uci)
        }
      }
      a.dispose()
    })
  }
})
