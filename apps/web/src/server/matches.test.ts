import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { makeRng } from '@duelwise/core/src/rng'
import { gzipSync } from '@duelwise/core/src/gzip'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { finishMatchFromUpload, MAX_BODY_BYTES, startMatchHandler } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { abandonStale } from './abandon'
import { GUEST_COOKIE, resolveGuest } from './guest'
import { readFileSync } from 'node:fs'
import { recordsTrainable } from '../lib/honest-copy'
import type { GameId } from '@duelwise/core/src/product'

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
  await db.execute(sql`truncate table match, guest, rating, profile`)
})

const GUEST = { guestId: 'g-1' }

/** Plays a whole Four in a Row game on the real core; seat 0 is the human, both pick random legal columns. */
function playFour(matchId: string, seed: number, level: MatchRecordV1['agent']['level'] = 'easy'): MatchRecordV1 {
  const rng = makeRng(seed ^ 0x9e37)
  let s = fourCore.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  while (!fourCore.terminal(s)) {
    const seat = fourCore.toAct(s)[0]!
    const legal = fourCore.legal(s, seat)
    const a = legal[rng.int(legal.length)]!
    actions.push([tick, seat, fourCore.encodeAction(a)])
    s = fourCore.step(s, seat === 0 ? [a, null] : [null, a])
    tick++
  }
  return {
    schema: 1, matchId, game: 'four', coreVersion: fourCore.version,
    agent: { version: 'v1', level }, seed, humanSeat: 0, actions,
    result: fourCore.result(s)!, finalHash: fourCore.hash(s),
    startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}

async function start(who = GUEST) {
  await db.insert(schema.guest).values({ id: 'g-1' }).onConflictDoNothing()
  await db.insert(schema.guest).values({ id: 'g-2' }).onConflictDoNothing()
  const r = await startMatchHandler(db, { game: 'four', level: 'easy' }, who, { agentVersion: () => 'v1', side: () => 0 as const })
  expect(r.status).toBe(200)
  return r.body as { matchId: string; seed: number; agentVersion: string }
}

describe('migrations', () => {
  test('apply to a fresh PGlite directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'duelwise-mig-'))
    const c = new PGlite(dir)
    try {
      const d = drizzle(c, { schema })
      await migrateDb(d)
      await migrateDb(d) // idempotent
      const tables = await d.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`)
      const names = tables.rows.map((r) => (r as { table_name: string }).table_name)
      for (const t of ['agent_version', 'guest', 'match', 'match_report', 'owner_audit', 'profile', 'rating', 'telemetry_event', 'training_run']) expect(names).toContain(t)
    } finally {
      await c.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('startMatch', () => {
  test('returns an id, a seed and the agent version, and stores a started row', async () => {
    const m = await start()
    expect(m.matchId.length).toBeGreaterThan(10)
    expect(Number.isInteger(m.seed)).toBe(true)
    expect(m.seed).toBeGreaterThanOrEqual(0)
    expect(m.seed).toBeLessThan(2 ** 32)
    expect(m.agentVersion).toBe('v1')
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.status).toBe('started')
    expect(row.guestId).toBe('g-1')
    expect(row.seed).toBe(m.seed)
  })

  test('two matches get different ids and (practically always) different seeds', async () => {
    const a = await start()
    const b = await start()
    expect(a.matchId).not.toBe(b.matchId)
    expect(a.seed).not.toBe(b.seed)
  })

  test('rejects an unknown game or level with 400', async () => {
    const r = await startMatchHandler(db, { game: 'checkers', level: 'easy' }, GUEST)
    expect(r.status).toBe(400)
    const r2 = await startMatchHandler(db, { game: 'four', level: 'godlike' }, GUEST)
    expect(r2.status).toBe(400)
  })

  test('needs a player (user or guest)', async () => {
    const r = await startMatchHandler(db, { game: 'four', level: 'easy' }, {})
    expect(r.status).toBe(401)
  })
})

describe('finishMatch', () => {
  test('a valid four record is stored finished and valid', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    const r = await finishMatchHandler(db, encodeRecord(rec), GUEST)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ valid: true, result: rec.result })
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.status).toBe('finished')
    expect(row.recordValid).toBe(true)
    expect(row.result).toEqual(rec.result)
    expect(row.record!.length).toBeGreaterThan(18)
    expect(row.finishedAt).not.toBeNull()
    expect(row.trainingAllowed).toBe(true)
  })

  test('an edited result gives valid false with a reason, and no rating', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    const w = rec.result.winner === 0 ? 1 : 0
    rec.result = { winner: w, score: w === 0 ? [1, 0] : [0, 1], reason: rec.result.reason }
    const r = await finishMatchHandler(db, encodeRecord(rec), GUEST)
    expect(r.status).toBe(200)
    const body = r.body as { valid: boolean; reason?: string; elo?: unknown }
    expect(body.valid).toBe(false)
    expect(body.reason).toMatch(/result|hash/i)
    expect(body.elo).toBeUndefined()
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.status).toBe('finished')
    expect(row.recordValid).toBe(false)
    expect(row.invalidReason).toBeTruthy()
    expect((await db.select().from(schema.rating)).length).toBe(0)
  })

  test('an edited action fails replay', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    const a = rec.actions[0]!
    rec.actions[0] = [a[0], a[1], (a[2] + 1) % 7]
    const r = await finishMatchHandler(db, encodeRecord(rec), GUEST)
    expect((r.body as { valid: boolean }).valid).toBe(false)
  })

  test('a record with a seed other than the issued one fails', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed + 1)
    const r = await finishMatchHandler(db, encodeRecord(rec), GUEST)
    const body = r.body as { valid: boolean; reason?: string }
    expect(body.valid).toBe(false)
    expect(body.reason).toMatch(/seed/i)
  })

  test('a record for another level than the one started fails', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed, 'champion')
    const body = (await finishMatchHandler(db, encodeRecord(rec), GUEST)).body as { valid: boolean; reason?: string }
    expect(body.valid).toBe(false)
    expect(body.reason).toMatch(/level/i)
  })

  test('malformed gzip is 400 and stores nothing', async () => {
    const m = await start()
    const r = await finishMatchHandler(db, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), GUEST)
    expect(r.status).toBe(400)
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.status).toBe('started')
  })

  test('gzip of something that is not a record is 400', async () => {
    await start()
    const r = await finishMatchHandler(db, gzipSync(new TextEncoder().encode('{"schema":2}')), GUEST)
    expect(r.status).toBe(400)
  })

  test('a body over 4.5 MB is 413', async () => {
    await start()
    const r = await finishMatchHandler(db, new Uint8Array(MAX_BODY_BYTES + 1), GUEST)
    expect(r.status).toBe(413)
  })

  test('finish with null input is 400, not a crash', async () => {
    expect((await finishMatchHandler(db, null, GUEST)).status).toBe(400)
  })

  test('start with null input is 400, not a crash', async () => {
    expect((await startMatchHandler(db, null, GUEST)).status).toBe(400)
  })

  describe('upload through the form path', () => {
    const form = (bytes: Uint8Array) => {
      const f = new FormData()
      f.set('record', new Blob([bytes.slice().buffer as ArrayBuffer]), 'record.gz')
      return f
    }
    test('a 1 MB valid-shaped body gets past the size limits (400 from the decoder, not 413)', async () => {
      const r = await finishMatchFromUpload(db, form(new Uint8Array(1_000_000)), '1000200', GUEST)
      expect(r.status).toBe(400)
    })
    test('a real record uploaded as a form file is accepted', async () => {
      const m = await start()
      const r = await finishMatchFromUpload(db, form(encodeRecord(playFour(m.matchId, m.seed))), '5000', GUEST)
      expect(r.status).toBe(200)
    })
    test('a 4.6 MB body is 413 by content-length, before reading it', async () => {
      const r = await finishMatchFromUpload(db, form(new Uint8Array(Math.floor(4.6 * 1024 * 1024))), '4824267', GUEST)
      expect(r.status).toBe(413)
    })
    test('a 4.6 MB body with no content-length is still 413', async () => {
      const r = await finishMatchFromUpload(db, form(new Uint8Array(Math.floor(4.6 * 1024 * 1024))), undefined, GUEST)
      expect(r.status).toBe(413)
    })
    test('non-form and missing-file inputs are 400', async () => {
      expect((await finishMatchFromUpload(db, null, '10', GUEST)).status).toBe(400)
      expect((await finishMatchFromUpload(db, new FormData(), '10', GUEST)).status).toBe(400)
    })
  })

  test('an unknown match id is 404', async () => {
    const rec = playFour('nope', 5)
    const r = await finishMatchHandler(db, encodeRecord(rec), GUEST)
    expect(r.status).toBe(404)
  })

  test('another player cannot finish my match (403)', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    const r = await finishMatchHandler(db, encodeRecord(rec), { guestId: 'g-2' })
    expect(r.status).toBe(403)
  })

  test('finishing twice is 409 and keeps the first result', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    expect((await finishMatchHandler(db, encodeRecord(rec), GUEST)).status).toBe(200)
    expect((await finishMatchHandler(db, encodeRecord(rec), GUEST)).status).toBe(409)
  })

  test('training stays off when the record says so', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    rec.trainingAllowed = false
    await finishMatchHandler(db, encodeRecord(rec), GUEST)
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.trainingAllowed).toBe(false)
  })

  test('training stays off for a game whose registry does not learn from humans, whatever the record says', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    expect(rec.trainingAllowed).toBe(true)
    await finishMatchHandler(db, encodeRecord(rec), GUEST, { recordsTrainable: () => false })
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.trainingAllowed).toBe(false)
  })

  test('production rule: a non-learning game is untrainable from start, and a forged trainable record cannot change it', async () => {
    const reg = (g: string) => JSON.parse(readFileSync(join(import.meta.dir, `../../../../packages/agents/registry/${g}.json`), 'utf8'))
    const gameRecordsTrainable = (g: GameId) => recordsTrainable(g, reg(g))
    await db.insert(schema.guest).values({ id: 'g-1', trainingAllowed: true })
    const r = await startMatchHandler(db, { game: 'chess', level: 'easy' }, GUEST, { recordsTrainable: gameRecordsTrainable })
    const id = (r.body as { matchId: string }).matchId
    expect((await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!.trainingAllowed).toBe(false)
    const four = await startMatchHandler(db, { game: 'four', level: 'easy' }, GUEST, { recordsTrainable: gameRecordsTrainable })
    expect((await db.select().from(schema.match).where(eq(schema.match.id, (four.body as { matchId: string }).matchId)))[0]!.trainingAllowed).toBe(true)
    expect(gameRecordsTrainable('chess')).toBe(false)
    expect(gameRecordsTrainable('four')).toBe(true)
  })

  test('production rule: opted-in guest on chess keeps the match untrainable but telemetry records no opt-out', async () => {
    const reg = (g: string) => JSON.parse(readFileSync(join(import.meta.dir, `../../../../packages/agents/registry/${g}.json`), 'utf8'))
    await db.insert(schema.guest).values({ id: 'g-1', trainingAllowed: true })
    const r = await startMatchHandler(db, { game: 'chess', level: 'easy' }, GUEST, { recordsTrainable: (g: GameId) => recordsTrainable(g, reg(g)) })
    const id = (r.body as { matchId: string }).matchId
    expect((await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!.trainingAllowed).toBe(false)
    const ev = (await db.select().from(schema.telemetryEvent)).filter((e) => e.matchId === id && e.kind === 'match_started')
    expect(ev.length).toBe(1)
    expect(ev[0]!.optedOut).toBe(false)
  })

  test('training stays on for a game that learns when the rule says so', async () => {
    const m = await start()
    await finishMatchHandler(db, encodeRecord(playFour(m.matchId, m.seed)), GUEST, { recordsTrainable: () => true })
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.trainingAllowed).toBe(true)
  })

  test('training stays off when the player opted out before the match', async () => {
    await db.insert(schema.guest).values({ id: 'g-1', trainingAllowed: false })
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    await finishMatchHandler(db, encodeRecord(rec), GUEST)
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.trainingAllowed).toBe(false)
  })
})

describe('abandonStale', () => {
  test('marks started matches past the game max duration plus grace abandoned and leaves the rest', async () => {
    const now = new Date('2026-10-21T12:00:00.000Z')
    const row = (id: string, startedAt: string, status: schema.MatchStatus = 'started') => ({
      id, game: 'four', guestId: 'g-1', agentVersion: 'v1', level: 'easy', seed: 1, status, startedAt: new Date(startedAt),
    })
    await db.insert(schema.guest).values({ id: 'g-1' })
    await db.insert(schema.match).values([
      row('old', '2026-10-21T10:59:00.000Z'),
      row('fresh', '2026-10-21T11:30:00.000Z'),
      row('old-finished', '2026-10-21T08:00:00.000Z', 'finished'),
    ])
    const n = await abandonStale(db, now)
    expect(n).toBe(1)
    const rows = Object.fromEntries((await db.select().from(schema.match)).map((r) => [r.id, r.status]))
    expect(rows).toEqual({ old: 'abandoned', fresh: 'started', 'old-finished': 'finished' })
  })
})

describe('guest cookie', () => {
  test('is created once and then reused', async () => {
    const first = await resolveGuest(db, null)
    expect(first.created).toBe(true)
    expect(first.setCookie).toContain(`${GUEST_COOKIE}=${first.id}`)
    expect(first.setCookie).toMatch(/HttpOnly/i)
    expect(first.setCookie).toMatch(/SameSite=Lax/i)

    const second = await resolveGuest(db, `other=1; ${GUEST_COOKIE}=${first.id}`)
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
    expect(second.setCookie).toBeUndefined()
    expect((await db.select().from(schema.guest)).length).toBe(1)
  })

  test('a cookie that is not a known guest is replaced, never trusted', async () => {
    const r = await resolveGuest(db, `${GUEST_COOKIE}=not-in-the-database`)
    expect(r.created).toBe(true)
    expect(r.id).not.toBe('not-in-the-database')
    const r2 = await resolveGuest(db, `${GUEST_COOKIE}=%00%00`)
    expect(r2.created).toBe(true)
  })
})
