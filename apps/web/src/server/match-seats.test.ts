import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { decodeRecord, encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { play } from './agent-check-fixtures'
import { getBoard } from './landing'
import { finishMatchHandler, startMatchHandler, type FinishOptions } from './match-handlers'
import { seatStats } from './record-seats'

type Db = PgliteDatabase<typeof schema>
let client: PGlite
let db: Db
beforeAll(async () => {
  client = new PGlite()
  db = drizzle(client, { schema })
  await migrateDb(db)
})
afterAll(() => client.close())
beforeEach(async () => {
  await db.execute(sql`truncate table match, guest, rating, profile, match_report, telemetry_event`)
})

const GUEST = { guestId: 'g-1' }
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!

async function begin(game: GameId, seed = 21) {
  const r = await startMatchHandler(db, { sides: 1, game, level: 'hard' }, GUEST, { seed: () => seed, side: () => 0 as const })
  return r.body as { matchId: string; seed: number }
}

describe('the finish writes the seat and the move count beside the record', () => {
  test('a valid finish stores the human seat and the count of the human actions, the same numbers the decode gives', async () => {
    const m = await begin('four')
    const rec = await play('four', m.seed, undefined, 'hard', m.matchId)
    const bytes = encodeRecord(rec)
    const r = await finishMatchHandler(db, bytes, GUEST, { verifyAgent: async () => ({ kind: 'verified' }) })
    expect(r.status).toBe(200)
    const row = await rowOf(m.matchId)
    const dec = decodeRecord(row.record!)
    expect(row.humanSeat).toBe(dec.humanSeat)
    expect(row.moves).toBe(dec.actions.filter((a) => a[1] === dec.humanSeat).length)
    expect(row.moves).toBeGreaterThan(0)
  })

  test('a refused record stores no bytes and no seat or count', async () => {
    const m = await begin('four')
    const rec = await play('four', m.seed, undefined, 'hard', m.matchId)
    const r = await finishMatchHandler(db, encodeRecord({ ...rec, seed: rec.seed + 1 }), GUEST, {})
    expect(r.status).toBe(200)
    const row = await rowOf(m.matchId)
    expect(row).toMatchObject({ recordValid: false, record: null, humanSeat: null, moves: null })
  })

  test('a check that fails after the answer withdraws the record and clears the seat and count with it', async () => {
    const m = await begin('four')
    const rec = await play('four', m.seed, undefined, 'hard', m.matchId)
    const pending: Promise<unknown>[] = []
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const opts: FinishOptions = {
      verifyAgent: async () => {
        await gate
        return { kind: 'forged', reason: 'x' } as never
      },
      deferCheck: (p) => void pending.push(p),
    }
    await finishMatchHandler(db, encodeRecord(rec), GUEST, opts)
    expect((await rowOf(m.matchId)).humanSeat).not.toBeNull()
    open()
    await Promise.all(pending)
    const after = await rowOf(m.matchId)
    expect(after).toMatchObject({ recordValid: false, record: null, humanSeat: null, moves: null })
  })
})

describe('a read uses the columns and reads a record only for a row with none', () => {
  const NOW = new Date('2026-10-21T12:00:00.000Z')
  async function put(id: string, humanSeat: 0 | 1, cols: boolean, withRecord = true) {
    const when = new Date(NOW.getTime() - 3_600_000)
    const result = { winner: humanSeat, score: [1, 0] as [number, number], reason: 'x' }
    const record = withRecord
      ? encodeRecord({ schema: 1, matchId: id, game: 'four', coreVersion: '1', agent: { version: 'v1', level: 'hard' }, seed: 1, humanSeat, actions: [[0, humanSeat, 1], [1, 1 - humanSeat, 2]], result, finalHash: '0123456789abcdef', startedAt: when.toISOString(), endedAt: when.toISOString(), device: 'desktop', input: 'mouse', trainingAllowed: true } as never)
      : null
    await db.insert(schema.match).values({ id, game: 'four', guestId: 'g', agentVersion: 'v1', level: 'hard', seed: 1, status: 'finished', result, record, recordValid: true, trainingAllowed: true, startedAt: when, finishedAt: when, ...(cols ? { humanSeat, moves: 1 } : {}) })
  }

  test('filled rows are answered from the columns with no record download; null rows fall back to the record', async () => {
    await put('filled-0', 0, true)
    await put('filled-1', 1, true)
    await put('legacy', 1, false)
    seatStats.fetched = 0
    const board = await getBoard(db, NOW)
    expect(seatStats.fetched).toBe(1)
    expect(board.humanWins).toBe(3)
  })

  test('a row with no record bytes is never counted, whatever its columns say (a withdrawn record)', async () => {
    await put('only-cols', 1, true, false)
    seatStats.fetched = 0
    // No record bytes: the row is treated as having none (as a withdrawn one), so it is not counted.
    expect((await getBoard(db, NOW)).humanWins).toBe(0)
    expect(seatStats.fetched).toBe(0)
  })
})
