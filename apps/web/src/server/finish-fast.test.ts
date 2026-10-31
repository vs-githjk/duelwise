import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { encodeRecord } from '@duelwise/core/src/match-record'
import type { GameId } from '@duelwise/core/src/product'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { fakeAgent, play } from './agent-check-fixtures'
import { checkAgentMoves, type AgentCheck } from './agent-check'
import { getReport } from './report'
import { setTrainingAllowed } from './profile'
import { finishMatchHandler, startMatchHandler, type FinishOptions } from './match-handlers'

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
const USER = { userId: 'u-1' }

async function begin(game: GameId, who: { userId?: string; guestId?: string }, seed = 21) {
  const r = await startMatchHandler(db, { game, level: 'hard' }, who, { seed: () => seed })
  return r.body as { matchId: string; seed: number }
}
const rowOf = async (id: string) => (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!

/** A check the test opens by hand, so the test can look at the database while it is still running. */
function gatedCheck(outcome: AgentCheck | Error) {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const calls = { n: 0 }
  const verifyAgent: FinishOptions['verifyAgent'] = async () => {
    calls.n++
    await gate
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  const pending: Promise<unknown>[] = []
  return { verifyAgent, deferCheck: (p: Promise<unknown>) => void pending.push(p), open, calls, settled: () => Promise.all(pending) }
}

for (const game of ['chess', 'four', 'holdem'] as const) {
  describe(`${game}: a guest's finish answers before the agent check`, () => {
    test('the response comes back while the check is still running, the report is ready, nothing is trainable yet', async () => {
      const m = await begin(game, GUEST)
      const rec = await play(game, m.seed, undefined, 'hard', m.matchId, game === 'holdem' ? { untilBust: true } : undefined)
      const g = gatedCheck({ kind: 'verified' })
      const r = await finishMatchHandler(db, encodeRecord(rec), GUEST, { verifyAgent: g.verifyAgent, deferCheck: g.deferCheck })
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ valid: true })
      const mid = await rowOf(m.matchId)
      expect(mid).toMatchObject({ status: 'finished', recordValid: true, trainingAllowed: false })
      expect(mid.record).not.toBeNull()
      const during = await getReport(db, m.matchId, GUEST)
      expect(during!.owner!.learning).toEqual({ state: 'checking' })
      g.open()
      await g.settled()
      expect(g.calls.n).toBe(1)
      const after = await rowOf(m.matchId)
      expect(after).toMatchObject({ status: 'finished', recordValid: true, trainingAllowed: true, invalidReason: null })
      expect(JSON.stringify(after.filterFlags ?? {})).not.toContain('deferredCheckAt')
      expect((await getReport(db, m.matchId, GUEST))!.owner!.learning).toEqual({ state: 'stored' })
    })

    test('opting out during a deferred check keeps this match out of training even after opting back in', async () => {
      await db.insert(schema.guest).values({ id: GUEST.guestId })
      const m = await begin(game, GUEST)
      const rec = await play(game, m.seed, undefined, 'hard', m.matchId, game === 'holdem' ? { untilBust: true } : undefined)
      const g = gatedCheck({ kind: 'verified' })
      await finishMatchHandler(db, encodeRecord(rec), GUEST, { verifyAgent: g.verifyAgent, deferCheck: g.deferCheck })
      await setTrainingAllowed(db, GUEST, false)
      await setTrainingAllowed(db, GUEST, true)
      g.open()
      await g.settled()
      expect((await rowOf(m.matchId)).trainingAllowed).toBe(false)
    })

    test('a forged guest record is rejected after the response: no stored bytes, not trainable, reason kept', async () => {
      const m = await begin(game, GUEST)
      const rec = await play(game, m.seed, 1, 'hard', m.matchId, game === 'holdem' ? { untilBust: true } : undefined)
      const check = (r: typeof rec) => checkAgentMoves(r, { makeAgent: async (g) => fakeAgent(g) })
      let release!: () => void
      const gate = new Promise<void>((x) => (release = x))
      const pending: Promise<unknown>[] = []
      const r = await finishMatchHandler(db, encodeRecord(rec), GUEST, { verifyAgent: async (x) => (await gate, check(x)), deferCheck: (p) => void pending.push(p) })
      expect(r.body).toMatchObject({ valid: true })
      release()
      await Promise.all(pending)
      const row = await rowOf(m.matchId)
      expect(row).toMatchObject({ recordValid: false, trainingAllowed: false, record: null })
      expect(row.invalidReason).toContain('opponent')
    })

    test('a check that throws rejects the match instead of leaving it valid', async () => {
      const m = await begin(game, GUEST)
      const rec = await play(game, m.seed, undefined, 'hard', m.matchId, game === 'holdem' ? { untilBust: true } : undefined)
      const g = gatedCheck(new Error('function killed'))
      await finishMatchHandler(db, encodeRecord(rec), GUEST, { verifyAgent: g.verifyAgent, deferCheck: g.deferCheck })
      g.open()
      await g.settled()
      expect(await rowOf(m.matchId)).toMatchObject({ recordValid: false, trainingAllowed: false, record: null })
    })

    test('a signed-in match still waits for its check (it moves a rating)', async () => {
      const m = await begin(game, USER)
      const rec = await play(game, m.seed, undefined, 'hard', m.matchId, game === 'holdem' ? { untilBust: true } : undefined)
      let finished = false
      const g = gatedCheck({ kind: 'verified' })
      const call = finishMatchHandler(db, encodeRecord(rec), USER, { verifyAgent: g.verifyAgent, deferCheck: g.deferCheck }).then((r) => ((finished = true), r))
      await new Promise((r) => setTimeout(r, 50))
      expect(finished).toBe(false)
      g.open()
      const r = await call
      expect(r.body).toMatchObject({ valid: true })
      expect(await g.settled()).toEqual([])
    })

    test('with no way to defer, a guest match is checked before the answer, as before', async () => {
      const m = await begin(game, GUEST)
      const rec = await play(game, m.seed, 1, 'hard', m.matchId, game === 'holdem' ? { untilBust: true } : undefined)
      const r = await finishMatchHandler(db, encodeRecord(rec), GUEST, { verifyAgent: (x) => checkAgentMoves(x, { makeAgent: async (g) => fakeAgent(g) }) })
      expect(r.body).toMatchObject({ valid: false })
    })
  })
}

describe('telemetry for a deferred check', () => {
  test('match_finished is written once, after the check, with its reason', async () => {
    const m = await begin('four', GUEST)
    const rec = await play('four', m.seed, 1, 'hard', m.matchId)
    const pending: Promise<unknown>[] = []
    await finishMatchHandler(db, encodeRecord(rec), GUEST, { verifyAgent: (x) => checkAgentMoves(x, { makeAgent: async (g) => fakeAgent(g) }), deferCheck: (p) => void pending.push(p) })
    await Promise.all(pending)
    const ev = (await db.select().from(schema.telemetryEvent)).filter((e) => e.kind === 'match_finished')
    expect(ev).toHaveLength(1)
    expect(JSON.stringify(ev[0])).toContain('opponent')
  })
})

describe('the platform hook', () => {
  const key = Symbol.for('@vercel/request-context')
  const g = globalThis as Record<symbol, unknown>
  test('is found on the Vercel request context and absent elsewhere', async () => {
    const { requestWaitUntil } = await import('./wait-until')
    delete g[key]
    expect(requestWaitUntil()).toBeUndefined()
    const seen: Promise<unknown>[] = []
    g[key] = { get: () => ({ waitUntil: (p: Promise<unknown>) => void seen.push(p) }) }
    try {
      const p = Promise.resolve(1)
      requestWaitUntil()!(p)
      expect(seen).toEqual([p])
    } finally {
      delete g[key]
    }
  })
})


test('off-platform background work runs without blocking', async () => {
  const { fireAndForget } = await import('./wait-until')
  let release!: () => void
  let settled = false
  const work = new Promise<void>((resolve) => { release = resolve }).then(() => { settled = true })
  fireAndForget(work)
  expect(settled).toBe(false)
  release()
  await work
  expect(settled).toBe(true)
})

test('server finish options do not defer without a platform hook', async () => {
  const source = await Bun.file(new URL('./finish-options.ts', import.meta.url)).text()
  expect(source).toContain('deferCheck: waitUntil')
  expect(source).not.toContain('fireAndForget')
})

test('maintenance withdraws a stale deferred check', async () => {
  const m = await begin('four', GUEST)
  const rec = await play('four', m.seed, undefined, 'hard', m.matchId)
  const g = gatedCheck({ kind: 'verified' })
  await finishMatchHandler(db, encodeRecord(rec), GUEST, { verifyAgent: g.verifyAgent, deferCheck: g.deferCheck })
  const { sweepDeferredChecks } = await import('./match-handlers')
  expect(await sweepDeferredChecks(db, new Date(Date.now() + 100_000))).toBe(1)
  expect(await rowOf(m.matchId)).toMatchObject({ recordValid: false, record: null, trainingAllowed: false })
  g.open()
  await g.settled()
  expect((await rowOf(m.matchId)).recordValid).toBe(false)
})
