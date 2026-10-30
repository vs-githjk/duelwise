import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { migrateDb } from '../src/db/migrate'
import * as schema from '../src/db/schema'
import { exportMatches } from './export-matches'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

const MOVES = [3, 3, 2, 4, 3, 2, 4, 1, 3, 5, 0, 6]
function record(id: string, seed: number, over: Partial<MatchRecordV1> = {}): MatchRecordV1 {
  return {
    schema: 1, matchId: id, game: 'four', coreVersion: '1', agent: { version: 'v1', level: 'hard' }, seed, humanSeat: 0,
    actions: MOVES.map((c, i) => [i, (i % 2) as 0 | 1, c] as [number, 0 | 1, number]),
    humanInputTimesMs: [820, 1310, 640, 2200, 905, 1500],
    result: { winner: 1, score: [0, 1], reason: 'four' }, finalHash: '0123456789abcdef',
    startedAt: '2026-10-22T08:00:00.000Z', endedAt: '2026-10-22T08:03:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: true,
    ...over,
  }
}

describe('export-matches', () => {
  test('filters a database it only copies, and writes matches, starts and a summary', async () => {
    const base = await mkdtemp(join(tmpdir(), 'duelwise-exp-test-'))
    dirs.push(base)
    const dbDir = join(base, 'pglite')
    const client = new PGlite(dbDir)
    const db = drizzle(client, { schema })
    await migrateDb(db)
    const row = (id: string, rec: MatchRecordV1 | null, over: Partial<typeof schema.match.$inferInsert> = {}) =>
      db.insert(schema.match).values({
        id, game: 'four', guestId: 'g', agentVersion: 'v1', level: 'hard', seed: rec?.seed ?? 1, status: 'finished', recordValid: true, trainingAllowed: true,
        record: rec ? encodeRecord(rec) : null, startedAt: new Date(Date.parse('2026-10-22T08:00:00Z') + Math.random() * 1000), ...over,
      })
    await row('good-1', record('good-1', 1))
    await row('dup-1', record('dup-1', 1))
    await row('bad-1', record('bad-1', 2), { recordValid: false })
    await row('gone-1', null, { status: 'started', recordValid: null })
    await client.close()

    const out = join(base, 'out')
    const s = await exportMatches({ game: 'four', dbDir, outDir: out })
    expect(s.total).toBe(4)
    expect(s.kept).toBe(1)
    expect(s.rejected).toEqual({ unfinished: 1, replay_invalid: 1, duplicate: 1 })
    const lines = (await readFile(join(out, 'matches.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.length).toBe(1)
    expect(lines[0].moves).toEqual(MOVES)
    const starts = JSON.parse(await readFile(join(out, 'starts.json'), 'utf8'))
    expect(starts.positions[0]).toEqual(MOVES.slice(0, 4))
    expect(s.startPositions).toBe(starts.positions.length)
  }, 60000)

  test('refuses a game with no filters', async () => {
    await expect(exportMatches({ game: 'chess', dbDir: '/nonexistent', outDir: '/nonexistent' })).rejects.toThrow('no training filters')
  })
})
