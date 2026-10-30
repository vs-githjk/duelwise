import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { makeRng } from '../../rng'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUCKETS,
  POLICY_RECORD_BYTES,
  bucketOf,
  movesFromMovetext,
  processPgn,
  readGames,
  samplePositions,
  type PgnHeaders,
} from './pgn-stream'

interface Fixture {
  white: number
  black: number
  tc: string
  seed: number
  plies: number
  termination?: string
}

/** A PGN game made of random legal moves, in Lichess style (clock comments, move numbers). */
function makePgn(f: Fixture, id: string): { text: string; plies: number; san: string[]; result: string } {
  const rng = makeRng(f.seed)
  const c = new Chess()
  const san: string[] = []
  while (san.length < f.plies && !c.isGameOver()) {
    const ms = c.moves()
    const m = ms[rng.int(ms.length)]!
    c.move(m)
    san.push(m)
  }
  const result = c.isCheckmate() ? (c.turn() === 'b' ? '1-0' : '0-1') : c.isGameOver() ? '1/2-1/2' : '1-0'
  const body = san
    .map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m} { [%clk 0:03:00] }` : `${Math.floor(i / 2) + 1}... ${m} { [%clk 0:02:58] }`))
    .join(' ')
  const text = [
    '[Event "Rated Blitz game"]',
    `[Site "https://lichess.org/${id}"]`,
    '[White "a"]',
    '[Black "b"]',
    `[Result "${result}"]`,
    `[WhiteElo "${f.white}"]`,
    `[BlackElo "${f.black}"]`,
    `[TimeControl "${f.tc}"]`,
    `[Termination "${f.termination ?? 'Normal'}"]`,
    '',
    `${body} ${result}`,
    '',
    '',
  ].join('\n')
  return { text, plies: san.length, san, result }
}

const toChunks = (s: string, size: number): AsyncIterable<Uint8Array> =>
  (async function* () {
    const b = new TextEncoder().encode(s)
    for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size)
  })()

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('pgn reader', () => {
  test('reads games across arbitrary chunk boundaries', async () => {
    const games = [
      makePgn({ white: 1500, black: 1490, tc: '300+0', seed: 1, plies: 60 }, 'aaaaaaaa'),
      makePgn({ white: 1100, black: 1150, tc: '180+2', seed: 2, plies: 40 }, 'bbbbbbbb'),
      makePgn({ white: 1900, black: 1850, tc: '600+5', seed: 3, plies: 50 }, 'cccccccc'),
    ]
    const text = games.map((g) => g.text).join('\n')
    for (const size of [7, 64, 100000]) {
      const got = await collect(readGames(toChunks(text, size)))
      expect(got.length).toBe(3)
      expect(got.map((g) => g.headers.Site)).toEqual(['https://lichess.org/aaaaaaaa', 'https://lichess.org/bbbbbbbb', 'https://lichess.org/cccccccc'])
      expect(movesFromMovetext(got[1]!.movetext)).toEqual(games[1]!.san)
    }
  })

  test('movetext parsing drops comments, numbers, NAGs and results', () => {
    expect(movesFromMovetext('1. e4 { [%clk 0:03:00] } 1... c5 $1 { [%eval 0.3] } 2. Nf3 O-O-O+ 1/2-1/2')).toEqual(['e4', 'c5', 'Nf3', 'O-O-O+'])
    expect(movesFromMovetext('*')).toEqual([])
  })
})

describe('bucket filter', () => {
  const h = (w: string, b: string, tc: string, term = 'Normal'): PgnHeaders => ({ WhiteElo: w, BlackElo: b, TimeControl: tc, Termination: term, Result: '1-0' })
  test('both players within 100 of 1100, 1500 or 1900', () => {
    expect(bucketOf(h('1100', '1100', '300+0'))).toBe('b1100')
    expect(bucketOf(h('1000', '1200', '300+0'))).toBe('b1100')
    expect(bucketOf(h('999', '1100', '300+0'))).toBeNull()
    expect(bucketOf(h('1100', '1201', '300+0'))).toBeNull()
    expect(bucketOf(h('1600', '1400', '180+0'))).toBe('b1500')
    expect(bucketOf(h('1801', '1999', '900+10'))).toBe('b1900')
    expect(bucketOf(h('1300', '1300', '300+0'))).toBeNull()
    expect(BUCKETS.map((b) => b.name)).toEqual(['b1100', 'b1500', 'b1900'])
  })
  test('base time at least 180 s; bad headers rejected', () => {
    expect(bucketOf(h('1500', '1500', '179+0'))).toBeNull()
    expect(bucketOf(h('1500', '1500', '180+0'))).toBe('b1500')
    expect(bucketOf(h('1500', '1500', '-'))).toBeNull()
    expect(bucketOf(h('?', '1500', '300+0'))).toBeNull()
    expect(bucketOf(h('1500', '1500', '300+0', 'Abandoned'))).toBeNull()
    expect(bucketOf({ ...h('1500', '1500', '300+0'), Result: '*' })).toBeNull()
    expect(bucketOf({ ...h('1500', '1500', '300+0'), Variant: 'Chess960' })).toBeNull()
  })
})

describe('position sampling', () => {
  test('counts are exact: skip 8 plies, at most 10, all of them for short games', () => {
    const long = makePgn({ white: 1500, black: 1500, tc: '300+0', seed: 11, plies: 70 }, 'x')
    expect(long.plies).toBeGreaterThanOrEqual(30)
    const a = samplePositions(long.san, makeRng(5), { skipPlies: 8, maxPositions: 10 })
    expect(a.length).toBe(10)
    expect(new Set(a.map((p) => p.ply)).size).toBe(10)
    for (const p of a) {
      expect(p.ply).toBeGreaterThanOrEqual(8)
      expect(p.ply).toBeLessThan(long.plies)
    }
    const short = makePgn({ white: 1500, black: 1500, tc: '300+0', seed: 12, plies: 14 }, 'y')
    const b = samplePositions(short.san, makeRng(5), { skipPlies: 8, maxPositions: 10 })
    expect(b.map((p) => p.ply)).toEqual([8, 9, 10, 11, 12, 13].slice(0, short.plies - 8))
    expect(samplePositions(short.san.slice(0, 8), makeRng(5), { skipPlies: 8, maxPositions: 10 })).toEqual([])
  })

  test('each sample is the position before the move played, with the right legal list', () => {
    const g = makePgn({ white: 1500, black: 1500, tc: '300+0', seed: 21, plies: 60 }, 'z')
    const ps = samplePositions(g.san, makeRng(9), { skipPlies: 8, maxPositions: 10 })
    for (const p of ps) {
      const c = new Chess()
      for (let i = 0; i < p.ply; i++) c.move(g.san[i]!)
      expect(p.fen).toBe(c.fen())
      const m = c.move(g.san[p.ply]!)
      expect(p.uci).toBe(m.from + m.to + (m.promotion && m.promotion !== 'q' ? m.promotion : ''))
      expect(p.legal).toContain(p.uci)
      expect(p.legal.length).toBe(new Chess(p.fen).moves().length)
    }
    // deterministic
    expect(samplePositions(g.san, makeRng(9), { skipPlies: 8, maxPositions: 10 })).toEqual(ps)
  })

  test('an illegal SAN raises so the caller can skip the game', () => {
    expect(() => samplePositions(['e4', 'e4'], makeRng(1), { skipPlies: 0, maxPositions: 10 })).toThrow()
  })
})

describe('processPgn end to end', () => {
  test('filters by bucket and time control and writes exact counts into shards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgn-stream-'))
    try {
      const specs: Array<[Fixture, string]> = [
        [{ white: 1500, black: 1450, tc: '300+0', seed: 31, plies: 60 }, 'g1'], // b1500
        [{ white: 1520, black: 1560, tc: '600+0', seed: 32, plies: 60 }, 'g2'], // b1500
        [{ white: 1500, black: 1500, tc: '60+0', seed: 33, plies: 60 }, 'g3'], // too fast
        [{ white: 1100, black: 1080, tc: '180+0', seed: 34, plies: 60 }, 'g4'], // b1100
        [{ white: 1300, black: 1300, tc: '300+0', seed: 35, plies: 60 }, 'g5'], // no bucket
        [{ white: 1900, black: 2000, tc: '300+0', seed: 36, plies: 60 }, 'g6'], // b1900
        [{ white: 1500, black: 1500, tc: '300+0', seed: 37, plies: 60, termination: 'Abandoned' }, 'g7'],
      ]
      const text = specs.map(([f, id]) => makePgn(f, id).text).join('\n')
      const stats = await processPgn(toChunks(text, 4096), { outDir: dir, shardRecords: 10, targets: { b1100: 1000, b1500: 1000, b1900: 1000 }, maxPositionsPerGame: 10, seedBase: 7 })
      expect(stats.games).toBe(7)
      expect(stats.perBucket.b1500.games).toBe(2)
      expect(stats.perBucket.b1100.games).toBe(1)
      expect(stats.perBucket.b1900.games).toBe(1)
      for (const b of ['b1100', 'b1500', 'b1900'] as const) expect(stats.perBucket[b].positions).toBe(stats.perBucket[b].games * 10)
      const idx = JSON.parse(readFileSync(join(dir, 'b1500', 'index.json'), 'utf8'))
      expect(idx.positions).toBe(20)
      expect(idx.recordBytes).toBe(POLICY_RECORD_BYTES)
      expect(idx.shards.map((s: { records: number }) => s.records)).toEqual([10, 10])
      const files = readdirSync(join(dir, 'b1500')).filter((f) => f.endsWith('.bin')).sort()
      expect(files.length).toBe(2)
      expect(readFileSync(join(dir, 'b1500', files[0]!)).length).toBe(10 * POLICY_RECORD_BYTES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stops reading once every bucket has reached its target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgn-stream-'))
    try {
      const text = Array.from({ length: 6 }, (_, i) => makePgn({ white: 1500, black: 1500, tc: '300+0', seed: 40 + i, plies: 60 }, `t${i}`).text).join('\n')
      const stats = await processPgn(toChunks(text, 4096), { outDir: dir, shardRecords: 100, targets: { b1100: 0, b1500: 20, b1900: 0 }, maxPositionsPerGame: 10, seedBase: 1 })
      expect(stats.perBucket.b1500.positions).toBe(20)
      expect(stats.games).toBeLessThan(6)
      expect(stats.reason).toBe('targets reached')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
