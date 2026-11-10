import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import { GRID, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { createBot } from '@duelwise/core/src/games/puck/bots'
import { observe, puckCore } from '@duelwise/core/src/games/puck/core'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import type { Level } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { PuckMatch } from '../games/puck/loop'
import { createMatchRecorder } from '../lib/match-recorder'
import { finishMatchHandler, startMatchHandler } from './match-handlers'

// A Glasscut page match, started on the server as Practice, is finished with the record the page makes (both seats' inputs) and the
// server's own replay accepts it under the opponent's level limits. It moves no rating.

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
  await db.execute(sql`truncate table match, guest, rating, profile, "user" cascade`)
  await db.insert(schema.user).values({ id: 'u-1', name: 'u-1', email: 'u-1@example.test' })
})
const USER = { userId: 'u-1' }

async function played(matchId: string, seed: number, level: Level) {
  const m = new PuckMatch(seed, level)
  const hand = createBot('striker', seed + 1)
  const rec = createMatchRecorder({ game: 'puck', matchId, seed, humanSeat: 0, agent: { version: 'preview', level }, trainingAllowed: false, device: 'desktop', input: 'mouse' })
  while (!m.over) {
    const f = m.s.frame
    const code = f % 2 === 0 ? (() => { const t = hand.act(observe(m.s, 0)); return unitToCell(t[0]) + GRID * unitToCell(t[1]) })() : NO_INPUT
    m.tick(code)
    rec.recordAction(f, 0, code)
    rec.recordAction(f, 1, m.inputs[1])
  }
  return (await rec.finish(puckCore, m.s)).record
}

describe('finishing a Glasscut match', () => {
  for (const level of ['easy', 'champion'] as const) {
    test(`${level}: a Practice record verifies, is stored, and changes no rating`, async () => {
      const start = await startMatchHandler(db, { sides: 1, game: 'puck', level, practice: true }, USER, { seed: () => 17, side: () => 0 as const })
      expect(start.status).toBe(200)
      const { matchId, seed } = start.body as { matchId: string; seed: number }
      const rec = await played(matchId, seed, level)
      const r = await finishMatchHandler(db, encodeRecord(rec), USER)
      expect(r.body).toMatchObject({ valid: true })
      expect((r.body as { elo?: unknown }).elo).toBeUndefined()
      const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!
      expect(row).toMatchObject({ status: 'finished', recordValid: true })
      expect((await db.select().from(schema.rating)).length).toBe(0)
    })
  }
})
