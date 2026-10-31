import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRng } from '../../rng'
import { EXPERT_BUCKET, isExpertGame, processExpert, resumePosition } from './expert-stream'
import { POLICY_RECORD_BYTES, readPolicyRecord } from './shards'

interface Fixture {
  white: number
  black: number
  tc: string
  seed: number
  plies: number
  title?: string
  termination?: string
}

function makePgn(f: Fixture, id: string): string {
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
  const body = san.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : `${Math.floor(i / 2) + 1}... ${m}`)).join(' ')
  return [
    '[Event "Rated Rapid game"]', `[Site "https://lichess.org/${id}"]`, '[White "a"]', '[Black "b"]', `[Result "${result}"]`,
    `[WhiteElo "${f.white}"]`, `[BlackElo "${f.black}"]`, ...(f.title ? [`[WhiteTitle "${f.title}"]`] : []), `[TimeControl "${f.tc}"]`,
    `[Termination "${f.termination ?? 'Normal'}"]`, '', `${body} ${result}`, '', '',
  ].join('\n')
}

async function* chunks(s: string, size = 701): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(s)
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'expert-test-'))

const GOOD: Fixture[] = [
  { white: 2300, black: 2250, tc: '600+0', seed: 1, plies: 60 },
  { white: 2210, black: 2400, tc: '300+3', seed: 2, plies: 50 },
  { white: 2500, black: 2201, tc: '180+0', seed: 3, plies: 45 },
]
const BAD: Fixture[] = [
  { white: 2300, black: 2150, tc: '600+0', seed: 4, plies: 60 }, // one player under 2200
  { white: 2600, black: 2600, tc: '60+0', seed: 5, plies: 60 }, // bullet
  { white: 2600, black: 2500, tc: '600+0', seed: 6, plies: 60, title: 'BOT' }, // a bot account
  { white: 2600, black: 2500, tc: '600+0', seed: 7, plies: 60, termination: 'Abandoned' },
]
const corpus = (): string => [...GOOD.slice(0, 1), ...BAD.slice(0, 2), ...GOOD.slice(1, 2), ...BAD.slice(2), ...GOOD.slice(2)].map((f, i) => makePgn(f, 'game' + String(i).padStart(4, '0'))).join('\n')
const expectedPositions = (): number => GOOD.reduce((a, f) => a + Math.min(20, Math.min(f.plies, 200) - 8), 0)

describe('isExpertGame', () => {
  const base = { Result: '1-0', WhiteElo: '2300', BlackElo: '2250', TimeControl: '600+0' }
  test('both players at the minimum, slower games, real results, no bots', () => {
    expect(isExpertGame(base)).toBe(true)
    expect(isExpertGame({ ...base, BlackElo: '2200' })).toBe(true)
    expect(isExpertGame({ ...base, BlackElo: '2199' })).toBe(false)
    expect(isExpertGame({ ...base, WhiteElo: '2199' })).toBe(false)
    expect(isExpertGame({ ...base, TimeControl: '179+0' })).toBe(false)
    expect(isExpertGame({ ...base, TimeControl: '180+0' })).toBe(true)
    expect(isExpertGame({ ...base, TimeControl: '300+0' }, { minElo: 2200, minBase: 300 })).toBe(true)
    expect(isExpertGame({ ...base, TimeControl: '180+0' }, { minElo: 2200, minBase: 300 })).toBe(false)
    expect(isExpertGame({ ...base, TimeControl: '-' })).toBe(false)
    expect(isExpertGame({ ...base, Result: '*' })).toBe(false)
    expect(isExpertGame({ ...base, Variant: 'Chess960' })).toBe(false)
    expect(isExpertGame({ ...base, Termination: 'Abandoned' })).toBe(false)
    expect(isExpertGame({ ...base, WhiteTitle: 'BOT' })).toBe(false)
    expect(isExpertGame({ ...base, BlackTitle: 'GM' })).toBe(true)
    expect(isExpertGame({ ...base, WhiteElo: undefined })).toBe(false)
    expect(isExpertGame({ ...base, WhiteElo: 'abc' })).toBe(false)
  })
})

describe('processExpert', () => {
  test('writes only expert games as b2200 policy shards and stops at the target', async () => {
    const out = tmp()
    try {
      const s = await processExpert(chunks(corpus()), { outDir: out, month: '2026-09', target: 10_000 })
      expect(s.gamesSeen).toBe(7)
      expect(s.gamesKept).toBe(3)
      expect(s.positions).toBe(expectedPositions())
      expect(s.reason).toBe('end of stream')
      const index = JSON.parse(readFileSync(join(out, EXPERT_BUCKET, 'index.json'), 'utf8'))
      expect(index.positions).toBe(expectedPositions())
      expect(index.source.bucket).toBe('b2200')
      const shard = readFileSync(join(out, EXPERT_BUCKET, index.shards[0].file))
      const rec = readPolicyRecord(new Uint8Array(shard.buffer, shard.byteOffset, POLICY_RECORD_BYTES))
      expect(rec.legal).toContain(rec.move)
      expect(rec.ply).toBeGreaterThanOrEqual(8)

      const out2 = tmp()
      const capped = await processExpert(chunks(corpus()), { outDir: out2, month: '2026-09', target: 25 })
      expect(capped.positions).toBe(25)
      expect(capped.reason).toBe('targets reached')
      rmSync(out2, { recursive: true, force: true })
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  test('a stopped run resumes where its last save left off and ends with exactly the data of an uninterrupted run', async () => {
    const whole = tmp()
    const split = tmp()
    try {
      await processExpert(chunks(corpus()), { outDir: whole, month: '2026-09', target: 10_000 })
      const first = await processExpert(chunks(corpus()), { outDir: split, month: '2026-09', target: 10_000, maxGames: 3 })
      expect(first.reason).toBe('game limit')
      expect(first.gamesSeen).toBe(3)
      const p = resumePosition(split, '2026-09', { minElo: 2200, minBase: 180 })
      expect(p?.gamesSeen).toBe(3)
      const second = await processExpert(chunks(corpus()), { outDir: split, month: '2026-09', target: 10_000, resume: true })
      expect(second.resumedFrom).toBe(3)
      expect(second.gamesSeen).toBe(7)
      expect(second.positions).toBe(expectedPositions())
      const bytes = (dir: string) => Buffer.concat(readdirSync(join(dir, EXPERT_BUCKET)).filter((f) => f.endsWith('.bin')).sort().map((f) => readFileSync(join(dir, EXPERT_BUCKET, f))))
      expect(bytes(split).equals(bytes(whole))).toBe(true)
    } finally {
      rmSync(whole, { recursive: true, force: true })
      rmSync(split, { recursive: true, force: true })
    }
  })

  test('resume is ignored for another month or another filter, and the shards start clean', async () => {
    const out = tmp()
    try {
      await processExpert(chunks(corpus()), { outDir: out, month: '2026-09', target: 10_000, maxGames: 3 })
      expect(resumePosition(out, '2026-08', { minElo: 2200, minBase: 180 })).toBeNull()
      expect(resumePosition(out, '2026-09', { minElo: 2300, minBase: 180 })).toBeNull()
      const other = await processExpert(chunks(corpus()), { outDir: out, month: '2026-08', target: 10_000, resume: true })
      expect(other.resumedFrom).toBe(0)
      expect(other.positions).toBe(expectedPositions())
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  test('a half-written shard left by a killed run is dropped on resume', async () => {
    const out = tmp()
    try {
      await processExpert(chunks(corpus()), { outDir: out, month: '2026-09', target: 10_000, maxGames: 3 })
      writeFileSync(join(out, EXPERT_BUCKET, 'shard-00099.bin'), 'junk')
      await processExpert(chunks(corpus()), { outDir: out, month: '2026-09', target: 10_000, resume: true })
      expect(existsSync(join(out, EXPERT_BUCKET, 'shard-00099.bin'))).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
