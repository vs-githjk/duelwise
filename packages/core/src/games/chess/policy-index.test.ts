import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { makeRng } from '../../rng'
import { POLICY_SIZE, REL_POLICY_SIZE, canonicalUci, decodeAbs, encodeAbs, mirrorUci, relDecode, relEncode } from './policy-index'

/** Random legal playouts; returns the FEN of every position visited. */
function randomFens(seed: number, plies: number): string[] {
  const rng = makeRng(seed)
  const c = new Chess()
  const out: string[] = [c.fen()]
  for (let i = 0; i < plies && !c.isGameOver(); i++) {
    const ms = c.moves({ verbose: true })
    const m = ms[rng.int(ms.length)]!
    c.move(m)
    out.push(c.fen())
  }
  return out
}

const SPECIAL = [
  'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', // both castles, both colours
  'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1',
  'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', // en passant available
  '4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1', // promotion (push)
  '1r2k3/P7/8/8/8/8/7p/4K1R1 w - - 0 1', // white promotion by push and capture
  '4k3/8/8/8/8/8/p5P1/1N2K2R b - - 0 1', // black promotion by push and capture
  '1n2k3/P1P5/8/8/8/8/8/4K3 w - - 0 1', // capture promotions both directions
]

describe('policy index', () => {
  test('sizes', () => {
    expect(POLICY_SIZE).toBe(4096 + 144)
    expect(REL_POLICY_SIZE).toBe(4096 + 72)
  })

  test('bijective over every legal move in 200 seeded positions plus special positions', () => {
    const fens: string[] = [...SPECIAL]
    for (let seed = 1; fens.length < 200 + SPECIAL.length; seed++) fens.push(...randomFens(seed, 60).slice(0, 12))
    let moves = 0
    let castles = 0
    let eps = 0
    let unders = 0
    for (const fen of fens) {
      const c = new Chess(fen)
      const seen = new Map<number, string>()
      for (const m of c.moves({ verbose: true })) {
        const uci = canonicalUci(m)
        const abs = encodeAbs(uci)
        expect(abs).toBeGreaterThanOrEqual(0)
        expect(abs).toBeLessThan(POLICY_SIZE)
        expect(decodeAbs(abs)).toBe(uci)
        expect(seen.has(abs)).toBe(false) // injective within a position
        seen.set(abs, uci)
        const rel = relEncode(uci, c.turn())
        expect(rel).toBeLessThan(REL_POLICY_SIZE)
        expect(relDecode(rel, c.turn())).toBe(uci)
        // queen promotions accept the explicit q suffix and map to the same index
        if (uci.length === 4 && m.promotion === 'q') expect(encodeAbs(uci + 'q')).toBe(abs)
        moves++
        if (m.isKingsideCastle() || m.isQueensideCastle()) castles++
        if (m.isEnPassant()) eps++
        if (m.promotion && m.promotion !== 'q') unders++
      }
    }
    expect(moves).toBeGreaterThan(5000)
    expect(castles).toBeGreaterThan(0)
    expect(eps).toBeGreaterThan(0)
    expect(unders).toBeGreaterThan(0)
  })

  test('every decodable absolute code encodes back to itself', () => {
    let valid = 0
    for (let n = 0; n < POLICY_SIZE; n++) {
      let uci: string
      try {
        uci = decodeAbs(n)
      } catch {
        expect(n).toBeGreaterThanOrEqual(4096) // only underpromotions that would leave the board are undecodable
        continue
      }
      expect(encodeAbs(uci)).toBe(n)
      valid++
    }
    expect(valid).toBe(4096 + 2 * 66)
  })

  test('mirror flips ranks and keeps the suffix', () => {
    expect(mirrorUci('e2e4')).toBe('e7e5')
    expect(mirrorUci('a7b8n')).toBe('a2b1n')
    expect(relEncode('e7e5', 'b')).toBe(relEncode('e2e4', 'w'))
    expect(relEncode('a2b1n', 'b')).toBe(relEncode('a7b8n', 'w'))
  })

  test('rejects malformed moves and codes', () => {
    expect(() => encodeAbs('e2')).toThrow()
    expect(() => encodeAbs('e2e9')).toThrow()
    expect(() => encodeAbs('e2e4x')).toThrow()
    expect(() => decodeAbs(-1)).toThrow()
    expect(() => decodeAbs(POLICY_SIZE)).toThrow()
    expect(() => decodeAbs(1.5)).toThrow()
  })
})
