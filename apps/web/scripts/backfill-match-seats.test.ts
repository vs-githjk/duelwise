import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { encodeRecord } from '@duelwise/core/src/match-record'
import { migrateDb } from '../src/db/migrate'
import * as schema from '../src/db/schema'
import { backfillSeats, type Progress, type Query } from './backfill-match-seats'

let client: PGlite
let q: Query
beforeAll(async () => {
  client = new PGlite()
  await migrateDb(drizzle(client, { schema }))
  q = async (text, params = []) => (await client.query(text, params)).rows as Array<Record<string, unknown>>
})
afterAll(() => client.close())

const WHEN = '2026-10-20T12:00:00.000Z'
async function put(id: string, seat: 0 | 1, own: number, opp: number, extra: { garbage?: boolean; noRecord?: boolean; filled?: boolean } = {}) {
  const actions = [...Array.from({ length: own }, (_, i) => [i, seat, 1]), ...Array.from({ length: opp }, (_, i) => [i, 1 - seat, 2])]
  const bytes = extra.garbage ? new Uint8Array([1, 2, 3]) : encodeRecord({ schema: 1, matchId: id, game: 'four', coreVersion: '1', agent: { version: 'v1', level: 'hard' }, seed: 1, humanSeat: seat, actions, result: { winner: seat, score: [1, 0], reason: 'x' }, finalHash: '0123456789abcdef', startedAt: WHEN, endedAt: WHEN, device: 'desktop', input: 'mouse', trainingAllowed: true } as never)
  await client.query(
    `insert into match (id, game, agent_version, level, seed, status, record, record_valid, human_seat, moves) values ($1, 'four', 'v1', 'hard', 1, 'finished', $2, true, $3, $4)`,
    [id, extra.noRecord ? null : bytes, extra.filled ? 1 - seat : null, extra.filled ? 99 : null],
  )
}
const cols = async (id: string) => (await q(`select human_seat as s, moves as n from match where id = $1`, [id]))[0]!

beforeEach(async () => {
  await q(`truncate table match`, [])
  await put('a1', 0, 3, 2)
  await put('a2', 1, 4, 4)
  await put('a3', 1, 0, 5)
  await put('a4', 0, 7, 0)
  await put('a5', 1, 1, 1)
  await put('bad', 0, 1, 1, { garbage: true })
  await put('none', 0, 1, 1, { noRecord: true })
  await put('done', 0, 2, 2, { filled: true })
})

describe('backfill-match-seats', () => {
  test('a dry run counts the waiting rows, reads one batch and writes nothing', async () => {
    const seen: Progress[] = []
    const sum = await backfillSeats(q, { write: false, batch: 2, onProgress: (p) => seen.push(p) })
    expect(sum).toMatchObject({ pending: 6, batches: 1, scanned: 2, filled: 2, undecodable: 0 })
    expect(seen.length).toBe(1)
    expect((await q(`select count(*)::int as n from match where human_seat is not null`, []))[0]!.n).toBe(1)
  })

  test('fills the seat and the count of the human actions in small batches and reports progress', async () => {
    const seen: Progress[] = []
    const sum = await backfillSeats(q, { write: true, batch: 2, onProgress: (p) => seen.push(p) })
    expect(sum).toMatchObject({ pending: 6, filled: 5, undecodable: 1, scanned: 6 })
    expect(seen.length).toBe(sum.batches)
    expect(sum.batches).toBe(3)
    expect(seen.map((p) => p.lastId)).toEqual(['a2', 'a4', 'bad'])
    expect(await cols('a1')).toEqual({ s: 0, n: 3 })
    expect(await cols('a2')).toEqual({ s: 1, n: 4 })
    expect(await cols('a3')).toEqual({ s: 1, n: 0 })
    expect(await cols('a4')).toEqual({ s: 0, n: 7 })
    expect(await cols('a5')).toEqual({ s: 1, n: 1 })
  })

  test('leaves undecodable and record-less rows null, and never overwrites a row the server already filled', async () => {
    await backfillSeats(q, { write: true })
    expect(await cols('bad')).toEqual({ s: null, n: null })
    expect(await cols('none')).toEqual({ s: null, n: null })
    expect(await cols('done')).toEqual({ s: 1, n: 99 })
  })

  test('is idempotent and resumable: a second run finds only the undecodable row, and --after skips earlier ids', async () => {
    await backfillSeats(q, { write: true, batch: 3 })
    const again = await backfillSeats(q, { write: true })
    expect(again).toMatchObject({ pending: 1, filled: 0, undecodable: 1 })
    await q(`update match set human_seat = null, moves = null where id in ('a1', 'a2', 'a5')`, [])
    const resumed = await backfillSeats(q, { write: true, after: 'a1' })
    expect(resumed.filled).toBe(2)
    expect(await cols('a1')).toEqual({ s: null, n: null })
    expect(await cols('a5')).toEqual({ s: 1, n: 1 })
  })

  test('the script never needs a URL to be importable and reads it only when run', async () => {
    const src = await Bun.file(new URL('./backfill-match-seats.ts', import.meta.url)).text()
    expect(src.match(/process\.env\.DATABASE_URL/g)?.length).toBe(1)
    expect(src).toContain("replaceAll(url, '[database url]')")
  })
})
