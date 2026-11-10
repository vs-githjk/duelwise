import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { RATED_NOT_OPEN, NO_OFFLINE_TICKETS } from '@duelwise/core/src/rated-path'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler } from './match-handlers'
import { issueTicketsHandler } from './ticket-issue'
import { TICKET_GAMES, ticketGamesFor } from '../lib/tickets'

// Glasscut (id puck) ships with no server check of its opponent, so it has no rated path: every match is stored as Practice whatever the start asks for,
// and no offline ticket is issued. It leaves RATED_NOT_OPEN only when a check exists (apps/web/src/server/agent-check.ts) and Vidyut says so.

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
const startOpts = { agentVersion: () => 'v1', side: () => 0 as const }

describe('Glasscut has no rated path yet', () => {
  test('it is on the list of games with no rated path and on no ticket list', () => {
    expect([...RATED_NOT_OPEN]).toContain('puck')
    expect(ticketGamesFor(RATED_NOT_OPEN)).not.toContain('puck')
    expect(TICKET_GAMES).not.toContain('puck')
    expect(NO_OFFLINE_TICKETS).not.toContain('puck')
  })

  test('a start that does not ask for Practice is stored as Practice, and so is one that asks for it', async () => {
    for (const extra of [{}, { practice: false }, { practice: true }]) {
      const r = await startMatchHandler(db, { game: 'puck', level: 'easy', ...extra }, USER, startOpts)
      expect(r.status).toBe(200)
      const id = (r.body as { matchId: string }).matchId
      const row = (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
      expect(row.filterFlags).toMatchObject({ practice: true })
    }
  })

  test('offline tickets are refused with the no rated matches yet line', async () => {
    const r = await issueTicketsHandler(db, { game: 'puck', level: 'easy', count: 2 }, USER, startOpts)
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toMatch(/Glasscut has no rated matches yet/)
  })
})
