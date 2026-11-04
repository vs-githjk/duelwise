import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { makeRng } from '@duelwise/core/src/rng'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { resignMatchHandler } from './resign'
import { ABANDON_GRACE_MS, abandonStale, MAX_MATCH_MS } from './abandon'
import { deleteAccount } from './account'
import { deviceClass, isOwner, ownerEntries, playerRef, recordEvent } from './telemetry'

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
  await db.execute(sql`truncate table match, guest, rating, profile, telemetry_event, owner_audit, "user" cascade`)
  await db.insert(schema.guest).values({ id: 'g-1' })
})

const GUEST = { guestId: 'g-1' }
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'

function playFour(matchId: string, seed: number): MatchRecordV1 {
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
    agent: { version: 'v1', level: 'easy' }, seed, humanSeat: 0, actions,
    result: fourCore.result(s)!, finalHash: fourCore.hash(s),
    startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}

const events = () => db.select().from(schema.telemetryEvent).orderBy(schema.telemetryEvent.at)

async function start(who: { userId?: string; guestId?: string } = GUEST, ua = PHONE_UA) {
  const r = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, who, { agentVersion: () => 'v1', userAgent: ua, side: () => 0 as const })
  if (!('matchId' in r.body)) throw new Error('start failed')
  return r.body
}

describe('device class', () => {
  test('maps a browser string to a class and never keeps the string', () => {
    expect(deviceClass(PHONE_UA)).toBe('phone')
    expect(deviceClass('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe('tablet')
    expect(deviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe('phone')
    expect(deviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36')).toBe('desktop')
    expect(deviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36')).toBe('headless')
    expect(deviceClass(undefined)).toBe('unknown')
    expect(deviceClass('curl/8.0')).toBe('unknown')
  })
})

describe('event writes per lifecycle path', () => {
  test('start writes match_started with game, level, persona, device class, training basis and an opaque player ref', async () => {
    const m = await start()
    const [e] = await events()
    expect(e).toMatchObject({ kind: 'match_started', matchId: m.matchId, game: 'four', level: 'easy', persona: 'Pip', device: 'phone', trainingBasis: 'legitimate-interest', optedOut: false, playerKind: 'guest' })
    expect(e!.playerRef).toBe(await playerRef('guest', 'g-1'))
    expect(JSON.stringify(e)).not.toContain('g-1')
    expect(JSON.stringify(e)).not.toContain('iPhone')
  })

  test('an opted-out player is flagged on the event', async () => {
    await db.update(schema.guest).set({ trainingAllowed: false }).where(eq(schema.guest.id, 'g-1'))
    await start()
    expect((await events())[0]!.optedOut).toBe(true)
  })

  test('finish writes match_finished with the outcome, a duration and the start device', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed)
    const r = await finishMatchHandler(db, encodeRecord(rec), GUEST)
    expect(r.status).toBe(200)
    const ev = await events()
    expect(ev.map((e) => e.kind)).toEqual(['match_started', 'match_finished'])
    const fin = ev[1]!
    expect(fin.device).toBe('phone')
    expect(['human', 'ai', 'draw']).toContain(fin.outcome!)
    expect(fin.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('an invalid record is a finished event with no outcome and the reason', async () => {
    const m = await start()
    const rec = playFour(m.matchId, m.seed + 1)
    await finishMatchHandler(db, encodeRecord(rec), GUEST)
    const fin = (await events()).find((e) => e.kind === 'match_finished')!
    expect(fin.outcome).toBeNull()
    expect(fin.reason).toContain('seed')
  })

  test('resign writes match_resigned', async () => {
    const m = await start()
    await resignMatchHandler(db, { matchId: m.matchId, tick: 3 }, GUEST)
    const ev = await events()
    expect(ev.map((e) => e.kind)).toEqual(['match_started', 'match_resigned'])
    expect(ev[1]!.device).toBe('phone')
  })

  test('the abandon sweep writes match_abandoned once per match', async () => {
    const m = await start()
    const now = new Date(Date.now() + MAX_MATCH_MS.four + ABANDON_GRACE_MS + 60_000)
    await abandonStale(db, now)
    await abandonStale(db, now)
    expect((await events()).map((e) => e.kind)).toEqual(['match_started', 'match_abandoned'])
    expect((await events())[1]!.matchId).toBe(m.matchId)
  })

  test('a telemetry failure never breaks the match path', async () => {
    await db.execute(sql`drop table telemetry_event`)
    try {
      const r = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, GUEST, { agentVersion: () => 'v1', side: () => 0 as const })
      expect(r.status).toBe(200)
      await expect(recordEvent(db, { kind: 'match_started', matchId: 'x', game: 'four', level: 'easy', who: GUEST })).resolves.toBeUndefined()
    } finally {
      await db.execute(sql`CREATE TABLE telemetry_event (
        id text PRIMARY KEY NOT NULL, at timestamp with time zone DEFAULT now() NOT NULL, kind text NOT NULL, match_id text NOT NULL,
        game text NOT NULL, level text NOT NULL, persona text NOT NULL, device text DEFAULT 'unknown' NOT NULL, duration_ms integer,
        outcome text, reason text, training_basis text NOT NULL, opted_out boolean DEFAULT false NOT NULL, player_ref text NOT NULL, player_kind text NOT NULL)`)
    }
  })

  test('deleting an account removes its telemetry events', async () => {
    await db.insert(schema.user).values({ id: 'u-1', name: 'A', email: 'a@x.test' })
    await start({ userId: 'u-1' })
    await start(GUEST)
    expect(await deleteAccount(db, 'u-1')).toBe(true)
    const left = await events()
    expect(left).toHaveLength(1)
    expect(left[0]!.playerKind).toBe('guest')
  })
})

describe('owner allowlist', () => {
  test('matches an email or an id from OWNER_EMAILS, case-insensitively, and nobody when unset', () => {
    const env = { OWNER_EMAILS: ' Vidyut@Example.com , user-123 ' }
    expect(ownerEntries(env)).toEqual(['vidyut@example.com', 'user-123'])
    expect(isOwner({ id: 'x', email: 'vidyut@example.com', emailVerified: true }, env)).toBe(true)
    expect(isOwner({ id: 'user-123', email: 'other@example.com', emailVerified: false }, env)).toBe(true)
    expect(isOwner({ id: 'x', email: 'other@example.com', emailVerified: true }, env)).toBe(false)
    expect(isOwner(null, env)).toBe(false)
    expect(isOwner({ id: 'x', email: 'vidyut@example.com', emailVerified: true }, {})).toBe(false)
    expect(isOwner({ id: 'x', email: '', emailVerified: true }, { OWNER_EMAILS: ',' })).toBe(false)
  })

  test('an email on the list only counts once the provider has verified it (M4)', () => {
    const env = { OWNER_EMAILS: 'vidyut@example.com' }
    expect(isOwner({ id: 'x', email: 'vidyut@example.com', emailVerified: false }, env)).toBe(false)
    expect(isOwner({ id: 'x', email: 'vidyut@example.com' }, env)).toBe(false)
    expect(isOwner({ id: 'x', email: 'vidyut@example.com', emailVerified: true }, env)).toBe(true)
  })
})
