import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { fleetCore, shipCells, type FleetObs } from '@duelwise/core/src/games/fleet'
import { decodeRecord, encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { makeRng } from '@duelwise/core/src/rng'
import { randomFleet, spotsFor } from '@duelwise/agents/src/fleet/placer'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler, type Caller } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { buildSealedLog, FLEET_SPEC, recordMatchesLog, sealedTurnHandler, type SealedTurnBody } from './sealed-duel'

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
  await db.insert(schema.guest).values({ id: 'g-1' }).onConflictDoNothing()
  await db.insert(schema.guest).values({ id: 'g-2' }).onConflictDoNothing()
})

const ME = { guestId: 'g-1' }
const OTHER = { guestId: 'g-2' }
const SEED = 987654321

async function startFleet(seed = SEED) {
  const r = await startMatchHandler(db, { game: 'fleet', level: 'easy' }, ME, { agentVersion: () => 'v1', seed: () => seed })
  expect(r.status).toBe(200)
  return r.body as { matchId: string; seed: number; sealed?: boolean }
}

const place = (p: { cell: number; vertical: boolean }) => fleetCore.encodeAction({ kind: 'place', cell: p.cell, vertical: p.vertical })
const SETUP = randomFleet(makeRng(7)).map(place)
const shot = (cell: number) => 200 + cell

const ask = (matchId: string, actions: number[], who: Caller = ME) => sealedTurnHandler(db, { matchId, actions }, who, FLEET_SPEC)
const bodyOf = (r: { body: unknown }) => r.body as SealedTurnBody

async function storedLog(matchId: string): Promise<{ human: number[]; agent: number[] }> {
  const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!
  return (row.filterFlags as { sealedLog: { human: number[]; agent: number[] } }).sealedLog
}

/** Shoots cells 0, 1, 2 ... until the server says the match is over; returns every human action and the last reply. */
async function playOut(matchId: string, setup = SETUP) {
  const human = [...setup]
  let last = bodyOf(await ask(matchId, human))
  for (let cell = 0; !last.over; cell++) {
    expect(cell).toBeLessThan(100)
    human.push(shot(cell))
    const r = await ask(matchId, human)
    expect(r.status).toBe(200)
    last = bodyOf(r)
  }
  return { human, last }
}

/** The honest record of a finished sealed match, the way the page will build it from the human actions and the revealed agent actions. */
function recordOf(matchId: string, seed: number, human: number[], agent: number[]): Uint8Array {
  let s = fleetCore.init(seed)
  const actions: [number, 0 | 1, number][] = []
  let tick = 0
  let hi = 0
  let ai = 0
  while (!fleetCore.terminal(s)) {
    const toAct = fleetCore.toAct(s)
    const step: [unknown, unknown] = [null, null]
    for (const seat of toAct) {
      const n = seat === 0 ? human[hi++]! : agent[ai++]!
      actions.push([tick, seat, n])
      step[seat] = fleetCore.decodeAction(n)
    }
    s = fleetCore.step(s, step as never)
    tick++
  }
  const rec: MatchRecordV1 = {
    schema: 1, matchId, game: 'fleet', coreVersion: fleetCore.version, agent: { version: 'v1', level: 'easy' }, seed, humanSeat: 0, actions,
    result: fleetCore.result(s)!, finalHash: fleetCore.hash(s), trainingAllowed: false,
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), device: 'phone', input: 'touch',
  }
  return encodeRecord(rec)
}

describe('start for a sealed turn game', () => {
  test('start hides the seed and says so', async () => {
    const m = await startFleet()
    expect(m.sealed).toBe(true)
    expect(m.seed).toBe(0)
    expect(JSON.stringify(m)).not.toContain(String(SEED))
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.seed).toBe(SEED)
  })
})

describe('setup', () => {
  test('is accepted once: five actions, then the agent has placed too and play begins', async () => {
    const m = await startFleet()
    const r = await ask(m.matchId, SETUP)
    expect(r.status).toBe(200)
    const body = bodyOf(r)
    const view = body.view as FleetObs
    expect(view.phase).toBe('play')
    expect(view.ships).toHaveLength(5)
    expect(body.over).toBe(false)
    const log = await storedLog(m.matchId)
    expect(log.human).toEqual(SETUP)
    expect(log.agent).toHaveLength(5)
  })

  test('a second, different setup is a 409 and changes nothing', async () => {
    const m = await startFleet()
    expect((await ask(m.matchId, SETUP)).status).toBe(200)
    const before = await storedLog(m.matchId)
    const other = randomFleet(makeRng(99)).map(place)
    expect(other).not.toEqual(SETUP)
    expect((await ask(m.matchId, other)).status).toBe(409)
    expect(await storedLog(m.matchId)).toEqual(before)
  })

  test('the first step must be exactly the setup actions', async () => {
    const m = await startFleet()
    expect((await ask(m.matchId, SETUP.slice(0, 4))).status).toBe(400)
    expect((await ask(m.matchId, [...SETUP, shot(0)])).status).toBe(400)
    expect((await ask(m.matchId, [])).status).toBe(400)
    expect((await ask(m.matchId, [...SETUP.slice(0, 4), 1.5])).status).toBe(400)
    // An illegal placement (the first ship twice over) is refused and nothing is stored.
    expect((await ask(m.matchId, [SETUP[0]!, SETUP[0]!, SETUP[2]!, SETUP[3]!, SETUP[4]!])).status).toBe(400)
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    expect(row.filterFlags).toBeNull()
  })
})

describe('turns', () => {
  test('a changed earlier action is a 409, and so is a gap of two shots', async () => {
    const m = await startFleet()
    expect((await ask(m.matchId, SETUP)).status).toBe(200)
    expect((await ask(m.matchId, [...SETUP, shot(0)])).status).toBe(200)
    // Earlier shot swapped.
    expect((await ask(m.matchId, [...SETUP, shot(1), shot(2)])).status).toBe(409)
    // Two new shots at once.
    expect((await ask(m.matchId, [...SETUP, shot(0), shot(1), shot(2)])).status).toBe(409)
    // An earlier setup action swapped with a still-legal one.
    const swapped = [...SETUP]
    swapped[4] = place(spotsFor(2).find((s) => place(s) !== SETUP[4])!)
    expect((await ask(m.matchId, [...swapped, shot(0), shot(1)])).status).toBe(409)
    expect((await storedLog(m.matchId)).human).toEqual([...SETUP, shot(0)])
  })

  test('a shot at a cell already fired is refused and nothing is stored', async () => {
    const m = await startFleet()
    await ask(m.matchId, SETUP)
    await ask(m.matchId, [...SETUP, shot(0)])
    expect((await ask(m.matchId, [...SETUP, shot(0), shot(0)])).status).toBe(400)
    expect((await storedLog(m.matchId)).human).toHaveLength(6)
  })

  test('two parallel turns: exactly one wins, the other is a 409', async () => {
    const m = await startFleet()
    await ask(m.matchId, SETUP)
    const [a, b] = await Promise.all([ask(m.matchId, [...SETUP, shot(10)]), ask(m.matchId, [...SETUP, shot(11)])])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const log = await storedLog(m.matchId)
    expect(log.human).toHaveLength(6)
    expect(log.agent).toHaveLength(6)
    const winner = a.status === 200 ? 10 : 11
    expect(log.human[5]).toBe(shot(winner))
  })

  test('a retried request returns the same reply and the agent does not move twice', async () => {
    const m = await startFleet()
    await ask(m.matchId, SETUP)
    const first = await ask(m.matchId, [...SETUP, shot(5)])
    const log1 = await storedLog(m.matchId)
    const again = await ask(m.matchId, [...SETUP, shot(5)])
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await storedLog(m.matchId)).toEqual(log1)
    // A shorter list than the stored one is not a retry of the latest turn: refused, nothing changes.
    expect((await ask(m.matchId, SETUP)).status).toBe(409)
    expect(await storedLog(m.matchId)).toEqual(log1)
  })

  test("the agent's move does not depend on human cells it has not hit", async () => {
    const a = await startFleet()
    await ask(a.matchId, SETUP)
    let last = bodyOf(await ask(a.matchId, [...SETUP, shot(0)]))
    last = bodyOf(await ask(a.matchId, [...SETUP, shot(0), shot(1)]))
    last = bodyOf(await ask(a.matchId, [...SETUP, shot(0), shot(1), shot(2)]))
    const firedByAgent = new Set((last.view as FleetObs).incoming.map((x) => x.cell))
    expect(firedByAgent.size).toBe(3)
    // Move the last ship (length 2) to a spot the agent has not touched and that is free of the other ships.
    const keep = randomFleet(makeRng(7)).slice(0, 4)
    const used = new Set(keep.flatMap(shipCells))
    const old = randomFleet(makeRng(7))[4]!
    for (const c of shipCells(old)) expect(firedByAgent.has(c)).toBe(false)
    const moved = spotsFor(2).find((s) => {
      const cells = shipCells({ ...s, length: 2 })
      return (s.cell !== old.cell || s.vertical !== old.vertical) && !cells.some((c) => used.has(c) || firedByAgent.has(c))
    })!
    const setupB = [...SETUP.slice(0, 4), place(moved)]
    expect(setupB).not.toEqual(SETUP)

    const b = await startFleet()
    await ask(b.matchId, setupB)
    await ask(b.matchId, [...setupB, shot(0)])
    await ask(b.matchId, [...setupB, shot(0), shot(1)])
    await ask(b.matchId, [...setupB, shot(0), shot(1), shot(2)])
    expect((await storedLog(b.matchId)).agent).toEqual((await storedLog(a.matchId)).agent)
  })
})

describe('access', () => {
  test("another player's match is a 403, a stranger with no id a 401", async () => {
    const m = await startFleet()
    expect((await ask(m.matchId, SETUP, OTHER)).status).toBe(403)
    expect((await ask(m.matchId, SETUP, {} as Caller)).status).toBe(401)
    expect((await storedLogOrNull(m.matchId))).toBeNull()
  })

  test('an unknown match is a 404, bad input a 400, and another game a 400', async () => {
    expect((await ask('00000000-0000-0000-0000-000000000000', SETUP)).status).toBe(404)
    expect((await sealedTurnHandler(db, { matchId: 5, actions: SETUP }, ME, FLEET_SPEC)).status).toBe(400)
    expect((await sealedTurnHandler(db, { matchId: 'x' }, ME, FLEET_SPEC)).status).toBe(400)
    const four = await startMatchHandler(db, { game: 'four', level: 'easy' }, ME, { agentVersion: () => 'v1', seed: () => 1 })
    expect((await ask((four.body as { matchId: string }).matchId, SETUP)).status).toBe(400)
  })

  test('a finished match is a 409', async () => {
    const m = await startFleet()
    await ask(m.matchId, SETUP)
    await db.update(schema.match).set({ status: 'finished' }).where(eq(schema.match.id, m.matchId))
    expect((await ask(m.matchId, [...SETUP, shot(0)])).status).toBe(409)
    expect((await ask(m.matchId, SETUP)).status).toBe(409)
  })
})

async function storedLogOrNull(matchId: string) {
  const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)))[0]!
  return (row.filterFlags as { sealedLog?: unknown } | null)?.sealedLog ?? null
}

describe('what the reply shows', () => {
  test('no enemy ship, seed or agent action while the match is on', async () => {
    const m = await startFleet()
    const r = bodyOf(await ask(m.matchId, SETUP))
    expect(r.reveal).toBeUndefined()
    const view = r.view as FleetObs
    expect(view.reveal).toBeNull()
    expect(view.sunk).toEqual([])
    expect(Object.keys(r).sort()).toEqual(['over', 'view'])
    const log = await storedLog(m.matchId)
    const text = JSON.stringify(r)
    expect(text).not.toContain(String(SEED))
    expect(text).not.toContain(JSON.stringify(log.agent))
  })

  test('the reveal appears only when the match is over', async () => {
    const m = await startFleet()
    await ask(m.matchId, SETUP)
    const mid = bodyOf(await ask(m.matchId, [...SETUP, shot(0)]))
    expect(mid.reveal).toBeUndefined()
    const { last } = await playOut(m.matchId)
    expect(last.over).toBe(true)
    expect(last.reveal).toBeDefined()
    expect(last.reveal!.seed).toBe(SEED)
    expect(last.reveal!.agentActions).toEqual((await storedLog(m.matchId)).agent)
    expect((last.view as FleetObs).reveal).not.toBeNull()
  })

  test('nothing is accepted after the game is over', async () => {
    const m = await startFleet()
    const { human } = await playOut(m.matchId)
    const spare = [...Array(100).keys()].find((c) => !human.includes(shot(c)))
    if (spare !== undefined) expect((await ask(m.matchId, [...human, shot(spare)])).status).toBe(409)
    // The finished log is still readable as a retry.
    expect((await ask(m.matchId, human)).status).toBe(200)
  })
})

describe('the record has to be the logged match', () => {
  test('the honest record of a played-out match is valid', async () => {
    const m = await startFleet()
    const { human, last } = await playOut(m.matchId)
    const done = await finishMatchHandler(db, recordOf(m.matchId, SEED, human, last.reveal!.agentActions), ME)
    expect(done.body).toMatchObject({ valid: true })
  })

  test('a self-built record for a match that was never played through the server is invalid', async () => {
    const m = await startFleet()
    // Anyone who knew the seed could run the sealed log offline; the server must still not count it.
    const human = [...SETUP]
    let built = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, human)
    for (let cell = 0; !fleetCore.terminal(built.state); cell++) {
      human.push(shot(cell))
      built = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, human)
    }
    const done = await finishMatchHandler(db, recordOf(m.matchId, SEED, human, built.agent), ME)
    expect(done.body).toMatchObject({ valid: false, reason: 'record does not match the logged turns' })
  })

  test('recordMatchesLog compares per seat, needs a finished log, and refuses a missing one', async () => {
    const m = await startFleet()
    const { human, last } = await playOut(m.matchId)
    const agent = last.reveal!.agentActions
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!
    const flags = row.filterFlags as Record<string, unknown>
    const rec = (h: number[], a: number[]) => decodeRecord(recordOf(m.matchId, SEED, h, a))
    expect(recordMatchesLog(rec(human, agent), flags)).toBe(true)
    expect(recordMatchesLog(rec(human, agent), null)).toBe(false)
    expect(recordMatchesLog(rec(human, agent), {})).toBe(false)
    // A log that has not reached the end of the game does not count.
    const partial = { sealedLog: { human: SETUP, agent: agent.slice(0, 5) } }
    expect(recordMatchesLog(rec(human, agent), partial)).toBe(false)
    // One human setup action differs.
    const edited = [...human]
    edited[4] = place(spotsFor(2).find((s) => place(s) !== human[4])!)
    const forged = rec(human, agent)
    forged.actions = forged.actions.map(([t, s, a]) => (t === 4 && s === 0 ? [t, s, edited[4]!] : [t, s, a]))
    expect(recordMatchesLog(forged, flags)).toBe(false)
    // One agent action differs.
    const forgedAgent = rec(human, agent)
    forgedAgent.actions = forgedAgent.actions.map(([t, s, a]) => (t === 0 && s === 1 ? [t, s, (a + 1) % 200] : [t, s, a]))
    expect(recordMatchesLog(forgedAgent, flags)).toBe(false)
  })
})
