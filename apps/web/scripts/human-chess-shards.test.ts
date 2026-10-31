import { afterAll, describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalUci } from '@duelwise/core/src/games/chess/policy-index'
import { makeRng } from '@duelwise/core/src/rng'
import { POLICY_RECORD_BYTES, readPolicyRecord } from '@duelwise/core/src/games/chess/shards'
import type { HumanRow } from './export-human'
import { buildHumanChessShards, SKIP_PLIES } from './human-chess-shards'

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function randomGame(seed: number, plies: number): string[] {
  const rng = makeRng(seed)
  const c = new Chess()
  const out: string[] = []
  while (out.length < plies && !c.isGameOver()) {
    const ms = c.moves({ verbose: true })
    const m = ms[rng.int(ms.length)]!
    c.move(m)
    out.push(canonicalUci(m))
  }
  return out
}

const row = (id: string, moves: string[], over: Partial<HumanRow> = {}): HumanRow => ({
  id, game: 'chess', player: 'p_x', traffic: 'human', level: 'hard', agentVersion: 'v1', humanSeat: 0, outcome: 'win', weight: 1, practice: false, left: false,
  startedAt: '2026-10-30T08:00:00.000Z', day: '2026-10-30', elo: null, profileOk: null, device: 'desktop', input: 'mouse', seed: 1, options: null,
  result: { winner: 0, score: [1, 0], reason: 'checkmate' }, actions: [], humanInputTimesMs: null, moves, ...over,
})

describe('human chess shards', () => {
  test('only the human\'s moves from ply 8 on become records, with the match weight beside each', () => {
    const out = mkdtempSync(join(tmpdir(), 'hcs-'))
    dirs.push(out)
    const moves = randomGame(11, 40)
    expect(moves.length).toBe(40)
    const stats = buildHumanChessShards([row('a', moves, { humanSeat: 0, weight: 2 }), row('b', randomGame(12, 30), { humanSeat: 1, weight: 0.5, result: { winner: 1, score: [0, 1], reason: 'x' } })], out)
    // white plies 8,10,...,38 = 16 records; black plies 9,11,...,29 = 11 records
    expect(stats.records).toBe(16 + 11)
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))
    expect(index.positions).toBe(27)
    const w = new Float32Array(readFileSync(join(out, 'weights.bin')).buffer.slice(0))
    expect(Array.from(w)).toEqual([...Array(16).fill(2), ...Array(11).fill(0.5)])
    const bin = readFileSync(join(out, index.shards[0].file))
    const first = readPolicyRecord(new Uint8Array(bin.buffer, bin.byteOffset, POLICY_RECORD_BYTES))
    expect(first.ply).toBe(SKIP_PLIES)
    expect(first.result).toBe(2) // the human (white) won
    expect(first.legal).toContain(first.move)
    const second = readPolicyRecord(new Uint8Array(bin.buffer, bin.byteOffset + 16 * POLICY_RECORD_BYTES, POLICY_RECORD_BYTES))
    expect(second.ply).toBe(9)
    expect(second.result).toBe(2) // black won there too
  })

  test('weight 0 matches (Easy) and unreplayable matches write nothing', () => {
    const out = mkdtempSync(join(tmpdir(), 'hcs-'))
    dirs.push(out)
    const stats = buildHumanChessShards([row('z', randomGame(13, 30), { weight: 0 }), row('bad', ['e2e4', 'e2e4', ...randomGame(14, 20)])], out)
    expect(stats).toEqual({ matches: 0, skippedZeroWeight: 1, skippedBadMoves: 1, records: 0 })
  })
})
