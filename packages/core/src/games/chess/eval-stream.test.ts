import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpToExpected, parseEvalLine, processEval } from './eval-stream'
import { VALUE_RECORD_BYTES, moverResult, policyRecord, readPolicyRecord, readValueRecord, valueRecord } from './shards'
import { relEncode } from './policy-index'

const line = (fen: string, evals: unknown) => JSON.stringify({ fen, evals })
const START4 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

describe('eval line parsing', () => {
  test('cp to expected score, white point of view', () => {
    expect(cpToExpected(0)).toBeCloseTo(0.5, 9)
    expect(cpToExpected(400)).toBeCloseTo(10 / 11, 9)
    expect(cpToExpected(-400)).toBeCloseTo(1 / 11, 9)
  })

  test('uses the deepest evaluation and its first line; white to move keeps the score', () => {
    const l = line(START4, [
      { pvs: [{ cp: 10, line: 'e2e4' }], knodes: 1, depth: 20 },
      { pvs: [{ cp: 400, line: 'e2e4' }, { cp: 300, line: 'd2d4' }], knodes: 1, depth: 40 },
    ])
    const r = parseEvalLine(l)!
    expect(r.fen).toBe(START4)
    expect(r.white).toBeCloseTo(10 / 11, 9)
  })

  test('mates are 0 or 1 for white; malformed lines return null', () => {
    expect(parseEvalLine(line('6k1/6p1/8/4K3/4NN2/8/8/8 w - -', [{ pvs: [{ mate: 15, line: 'e5e6' }], knodes: 1, depth: 9 }]))!.white).toBe(1)
    expect(parseEvalLine(line('6k1/6p1/8/4K3/4NN2/8/8/8 b - -', [{ pvs: [{ mate: -3, line: 'g8f8' }], knodes: 1, depth: 9 }]))!.white).toBe(0)
    expect(parseEvalLine(line(START4, [{ pvs: [{ mate: 0, line: '' }], knodes: 1, depth: 9 }]))).toBeNull()
    expect(parseEvalLine('not json')).toBeNull()
    expect(parseEvalLine(line(START4, []))).toBeNull()
    expect(parseEvalLine(line('garbage', [{ pvs: [{ cp: 1, line: 'x' }], knodes: 1, depth: 1 }]))).toBeNull()
  })
})

describe('value records and shards', () => {
  test('black to move: features are mirrored and the target is the mover\'s', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - -'
    const p = parseEvalLine(line(fen, [{ pvs: [{ cp: 400, line: 'e8e7' }], knodes: 1, depth: 30 }]))!
    const r = readValueRecord(valueRecord(p.fen, p.white))
    expect(r.target).toBeCloseTo(1 / 11, 5) // white is better, so black (the mover) is not
    // black king e8 is the mover's own king on relative e1 (kind 5 own K): 5 * 64 + 4; white pawn e2 -> opponent pawn on relative e7: 6 * 64 + 52
    expect(r.features).toEqual([5 * 64 + 4, 6 * 64 + 52, 11 * 64 + 60])
  })

  test('processEval writes exactly the target count and stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-stream-'))
    try {
      const lines = Array.from({ length: 50 }, (_, i) => line(START4, [{ pvs: [{ cp: i * 10, line: 'e2e4' }], knodes: 1, depth: 20 }]))
      const text = lines.join('\n') + '\n'
      const src = (async function* () {
        for (let i = 0; i < text.length; i += 333) yield text.slice(i, i + 333)
      })()
      const stats = await processEval(src, { outDir: dir, target: 30, shardRecords: 12 })
      expect(stats.positions).toBe(30)
      expect(stats.reason).toBe('targets reached')
      const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
      expect(idx.kind).toBe('value')
      expect(idx.recordBytes).toBe(VALUE_RECORD_BYTES)
      expect(idx.shards.map((s: { records: number }) => s.records)).toEqual([12, 12, 6])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bad positions in the data', () => {
  test('a position with more than 32 pieces is skipped and counted, not fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-stream-'))
    try {
      const bad = 'rnbqk1nr/1pp2ppp/pbnp4/3Pp3/B3P3/2P2N2/PP3PPP/RNBQKBNR b KQkq -'
      const text = [line(bad, [{ pvs: [{ cp: 5, line: 'a' }], knodes: 1, depth: 9 }]), line(START4, [{ pvs: [{ cp: 5, line: 'a' }], knodes: 1, depth: 9 }]), ''].join('\n')
      const stats = await processEval((async function* () { yield text })(), { outDir: dir, target: 10 })
      expect(stats.positions).toBe(1)
      expect(stats.skipped).toBe(1)
      expect(stats.reason).toBe('end of stream')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('policy record layout', () => {
  test('round trips board, flags, move, ply and legal mask from the mover\'s side', () => {
    const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 7 3'
    const legal = ['e5f6', 'e5e6', 'a2a3']
    const rec = policyRecord(fen, 'e5f6', legal, moverResult('1-0', true), 12)
    const r = readPolicyRecord(rec)
    expect(r.result).toBe(2)
    expect(r.move).toBe(relEncode('e5f6', 'w'))
    expect(r.ply).toBe(12)
    expect(r.ep).toBe(45)
    expect(r.halfmove).toBe(7)
    expect(r.castling).toBe(15)
    expect(r.board[36]).toBe(1) // own pawn on e5
    expect(r.legal).toEqual(legal.map((m) => relEncode(m, 'w')).sort((a, b) => a - b))
    const b = readPolicyRecord(policyRecord('4k3/8/8/8/8/8/4P3/4K3 b - - 0 1', 'e8e7', ['e8e7'], moverResult('1-0', false), 0))
    expect(b.result).toBe(0)
    expect(b.move).toBe(relEncode('e1e2', 'w')) // mirrored: black's e8e7 is e1e2 from the mover's side
  })
})
