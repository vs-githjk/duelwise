import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { makeRng } from '../../rng'
import { chessCore, type ChessState } from './core'
import { legalUci } from './legal'
import { canonicalUci } from './policy-index'
import { chessPlaneEncoder, PLANES } from './encode'
import { parsePosition, toPerspective } from './position'
import { SPARSE_FEATURES, chessSparseEncoder, sparseIndices } from './sparse'

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'

function legalCount(s: ChessState): number {
  const seat = chessCore.toAct(s)[0]
  return seat === undefined ? 0 : chessCore.legal(s, seat).length
}

/** Leaves at `depth`, counting legal moves at the last ply instead of stepping into each one. */
function perft(s: ChessState, depth: number): number {
  if (depth === 0) return 1
  if (depth === 1) return legalCount(s)
  const seat = chessCore.toAct(s)[0]
  if (seat === undefined) return 0
  let n = 0
  for (const a of chessCore.legal(s, seat)) {
    const t: [string | null, string | null] = seat === 0 ? [a, null] : [null, a]
    n += perft(chessCore.step(s, t), depth - 1)
  }
  return n
}

function play(s: ChessState, uci: string): ChessState {
  const seat = chessCore.toAct(s)[0]!
  return chessCore.step(s, seat === 0 ? [uci, null] : [null, uci])
}

describe('chess core: perft', () => {
  const T = 120_000
  test('start position depth 1 to 4', () => {
    const s = chessCore.init(0)
    expect([1, 2, 3, 4].map((d) => perft(s, d))).toEqual([20, 400, 8902, 197281])
  }, T)
  test('Kiwipete depth 1 to 3', () => {
    const s = chessCore.init(0, { fen: KIWIPETE })
    expect([1, 2, 3].map((d) => perft(s, d))).toEqual([48, 2039, 97862])
  }, T)
})

describe('chess core: contract', () => {
  test('identity, seats, hash determinism', () => {
    const a = chessCore.init(1)
    const b = chessCore.init(999)
    expect(chessCore.id).toBe('chess')
    expect(chessCore.toAct(a)).toEqual([0])
    expect(chessCore.legal(a, 1)).toEqual([])
    expect(chessCore.hash(a)).toBe(chessCore.hash(b))
    expect(chessCore.hash(a)).toMatch(/^[0-9a-f]{16}$/)
    const e4 = play(a, 'e2e4')
    expect(chessCore.toAct(e4)).toEqual([1])
    expect(chessCore.hash(e4)).not.toBe(chessCore.hash(a))
    expect(chessCore.hash(play(a, 'e2e4'))).toBe(chessCore.hash(e4))
  })

  test('step is pure and rejects the wrong seat, missing or illegal actions', () => {
    const a = chessCore.init(0)
    const before = JSON.stringify(a)
    play(a, 'e2e4')
    expect(JSON.stringify(a)).toBe(before)
    expect(() => chessCore.step(a, [null, 'e7e5'])).toThrow()
    expect(() => chessCore.step(a, ['e2e4', 'e7e5'])).toThrow()
    expect(() => chessCore.step(a, [null, null])).toThrow()
    expect(() => chessCore.step(a, ['e2e5', null])).toThrow()
  })

  test('actions encode and decode, queen promotion accepts the q suffix', () => {
    const s = chessCore.init(0, { fen: '4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1' })
    const legal = chessCore.legal(s, 0)
    expect(legal).toContain('b7b8') // queen promotion is canonical without a suffix
    expect(legal).toContain('b7b8n')
    for (const a of legal) expect(chessCore.decodeAction(chessCore.encodeAction(a))).toBe(a)
    const viaSuffix = play(s, 'b7b8q')
    const viaCanonical = play(s, 'b7b8')
    expect(chessCore.hash(viaSuffix)).toBe(chessCore.hash(viaCanonical))
    expect(new Chess(viaCanonical.fen).get('b8')).toMatchObject({ type: 'q', color: 'w' })
    expect(new Chess(play(s, 'b7b8n').fen).get('b8')?.type).toBe('n')
    expect(() => chessCore.decodeAction(-1)).toThrow()
    expect(() => chessCore.encodeAction('zz')).toThrow()
  })

  test('checkmate (fool\'s mate): black wins, score [0,1]', () => {
    let s = chessCore.init(0)
    for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) s = play(s, m)
    expect(chessCore.terminal(s)).toBe(true)
    expect(chessCore.toAct(s)).toEqual([])
    expect(chessCore.result(s)).toEqual({ winner: 1, score: [0, 1], reason: 'checkmate' })
  })

  test('result is null while the game is on', () => {
    expect(chessCore.result(chessCore.init(0))).toBeNull()
    expect(chessCore.terminal(chessCore.init(0))).toBe(false)
  })
})

describe('chess core: draw rules', () => {
  test('stalemate', () => {
    const st = chessCore.init(0, { fen: 'k7/8/1Q6/8/8/8/8/6K1 w - - 0 1' })
    const after = play(st, 'b6c7') // black king a8 has no move: stalemate
    expect(chessCore.result(after)).toEqual({ winner: null, score: [0.5, 0.5], reason: 'stalemate' })
  })

  test('insufficient material', () => {
    const s = chessCore.init(0, { fen: '8/8/4k3/8/8/3NK3/8/8 w - - 0 1' })
    expect(chessCore.result(s)).toEqual({ winner: null, score: [0.5, 0.5], reason: 'insufficient material' })
    const t = chessCore.init(0, { fen: '8/8/4k3/8/8/3NKN2/8/8 w - - 0 1' })
    expect(chessCore.terminal(t)).toBe(false)
  })

  test('fifty-move rule triggers at a halfmove clock of 100', () => {
    const s = chessCore.init(0, { fen: '4k3/8/8/8/8/8/R7/4K3 w - - 99 80' })
    expect(chessCore.terminal(s)).toBe(false)
    const t = play(s, 'a2a3')
    expect(chessCore.result(t)).toEqual({ winner: null, score: [0.5, 0.5], reason: 'fifty-move rule' })
  })

  test('checkmate delivered on the hundredth halfmove still wins', () => {
    const s = chessCore.init(0, { fen: '6k1/5ppp/8/8/8/8/8/R3K3 w - - 99 80' })
    expect(chessCore.result(play(s, 'a1a8'))).toEqual({ winner: 0, score: [1, 0], reason: 'checkmate' })
  })

  test('threefold repetition is counted across steps, not just in the FEN', () => {
    let s = chessCore.init(0)
    const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8']
    for (let i = 0; i < 2; i++) for (const m of cycle) s = play(s, m)
    // the start position has now occurred three times (initial + after each cycle)
    expect(chessCore.result(s)).toEqual({ winner: null, score: [0.5, 0.5], reason: 'threefold repetition' })
    let u = chessCore.init(0)
    for (const m of cycle) u = play(u, m)
    expect(chessCore.terminal(u)).toBe(false) // only twice so far
  })

  test('an irreversible move clears the repetition history', () => {
    let s = chessCore.init(0)
    for (const m of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'e2e4', 'e7e5']) s = play(s, m)
    expect(s.keys.length).toBe(1)
  })

  test('observe hides nothing and reports the repetition count', () => {
    let s = chessCore.init(0)
    for (const m of ['g1f3', 'g8f6', 'f3g1', 'f6g8']) s = play(s, m)
    const o = chessCore.observe(s, 0)
    expect(o.toMove).toBe(true)
    expect(o.repeats).toBe(2)
    expect(chessCore.observe(s, 1).toMove).toBe(false)
  })
})

describe('chess core: random playouts agree with chess.js', () => {
  test('legal moves and terminal flags match over 20 seeded games', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = makeRng(seed)
      let s = chessCore.init(seed)
      const ref = new Chess()
      for (let ply = 0; ply < 120 && !chessCore.terminal(s); ply++) {
        const seat = chessCore.toAct(s)[0]!
        const mine = new Set(chessCore.legal(s, seat))
        const theirs = ref.moves({ verbose: true })
        expect(mine.size).toBe(theirs.length)
        const m = theirs[rng.int(theirs.length)]!
        ref.move(m)
        s = play(s, m.from + m.to + (m.promotion ?? ''))
        expect(s.fen.split(' ').slice(0, 4).join(' ')).toBe(ref.fen().split(' ').slice(0, 4).join(' '))
      }
    }
  }, 120_000)
})

describe('chess encoders', () => {
  test('plane encoder shape and start-position planes from the mover\'s side', () => {
    expect(chessPlaneEncoder.shape).toEqual([PLANES, 8, 8])
    const out = new Float32Array(PLANES * 64)
    chessPlaneEncoder.encode(chessCore.observe(chessCore.init(0), 0), out, 0)
    const plane = (p: number) => Array.from(out.slice(p * 64, p * 64 + 64))
    expect(plane(0).reduce((a, b) => a + b, 0)).toBe(8) // own pawns
    expect(plane(0).slice(8, 16)).toEqual(new Array(8).fill(1)) // on relative rank 2
    expect(plane(5)[4]).toBe(1) // own king on e1
    expect(plane(11)[60]).toBe(1) // opponent king on e8
    for (const p of [12, 13, 14, 15]) expect(plane(p)).toEqual(new Array(64).fill(1)) // all castling rights
    expect(plane(16).reduce((a, b) => a + b, 0)).toBe(0) // no en passant
    expect(plane(17)).toEqual(new Array(64).fill(0)) // halfmove clock 0
  })

  test('a position and its colour-flipped mirror encode identically', () => {
    const white = chessCore.init(0, { fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' })
    const black = chessCore.init(0, { fen: 'rnbqkb1r/pppp1ppp/5n2/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2' })
    const a = new Float32Array(PLANES * 64)
    const b = new Float32Array(PLANES * 64)
    chessPlaneEncoder.encode(chessCore.observe(white, 1), a, 0)
    chessPlaneEncoder.encode(chessCore.observe(black, 0), b, 0)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  test('en passant square and halfmove clock planes', () => {
    const s = chessCore.init(0, { fen: 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 7 3' })
    const out = new Float32Array(PLANES * 64)
    chessPlaneEncoder.encode(chessCore.observe(s, 0), out, 0)
    expect(out[16 * 64 + 45]).toBe(1) // f6 = rank 6, file f = 5*8+5
    expect(out[17 * 64]).toBeCloseTo(0.07, 6)
  })

  test('sparse encoder: indices are piece count long, sorted, unique and perspective based', () => {
    const o = chessCore.observe(chessCore.init(0), 0)
    const idx = sparseIndices(o)
    expect(idx.length).toBe(32)
    expect(Array.from(idx)).toEqual(Array.from(idx).sort((x, y) => x - y))
    expect(new Set(idx).size).toBe(32)
    expect(SPARSE_FEATURES).toBe(768)
    expect(idx).toContain(0 * 64 + 8) // own pawn on relative a2
    expect(idx).toContain(11 * 64 + 60) // opponent king on relative e8
    const dense = new Float32Array(768)
    chessSparseEncoder.encode(o, dense, 0)
    expect(dense.reduce((a, b) => a + b, 0)).toBe(32)
    for (const i of idx) expect(dense[i]).toBe(1)
  })

  test('position parsing: perspective flips squares and colours for black', () => {
    const p = parsePosition('4k3/8/8/8/8/8/4P3/4K3 b - - 0 1')
    const rel = toPerspective(p)
    expect(rel.board[4]).toBe(6) // black king on e8 is the mover's own king, shown on relative e1
    expect(rel.board[60]).toBe(12) // white king on e1 is the opponent's king on relative e8
    expect(rel.board[52]).toBe(7) // white pawn on e2 is an opponent pawn on relative e7
  })
})

describe('legalUci', () => {
  test('matches chess.js verbose moves, in order, over seeded games and special positions', () => {
    const fens = [
      KIWIPETE,
      'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1',
      'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3',
      '1n2k3/P1P5/8/8/8/8/8/4K3 w - - 0 1',
      '4k3/8/8/8/8/8/p5P1/1N2K2R b - - 0 1',
      '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
    ]
    for (let seed = 1; seed <= 15; seed++) {
      const rng = makeRng(seed)
      const c = new Chess()
      for (let ply = 0; ply < 100 && !c.isGameOver(); ply++) {
        fens.push(c.fen())
        const ms = c.moves({ verbose: true })
        c.move(ms[rng.int(ms.length)]!)
      }
    }
    for (const fen of fens) {
      const c = new Chess(fen)
      expect(legalUci(c)).toEqual(c.moves({ verbose: true }).map((m) => canonicalUci(m)))
    }
  })
})
