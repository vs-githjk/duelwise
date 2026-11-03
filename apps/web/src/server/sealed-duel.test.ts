import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { fleetCore, shipCells, type FleetObs, type FleetState } from '@duelwise/core/src/games/fleet'
import { decodeRecord, encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { makeRng } from '@duelwise/core/src/rng'
import { chooseFleetAction } from '@duelwise/agents/src/fleet/agent'
import { randomFleet, spotsFor } from '@duelwise/agents/src/fleet/placer'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { startMatchHandler, type Caller } from './match-handlers'
import { finishUnchecked as finishMatchHandler } from './finish-unchecked'
import { abandonStale } from './abandon'
import { SEALED_SETUP_TICKS } from './competitive'
import { getMyRecord } from './landing'
import { resignMatchHandler } from './resign'
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
  const r = await startMatchHandler(db, { sides: 1, game: 'fleet', level: 'easy' }, ME, { agentVersion: () => 'v1', seed: () => seed })
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

  test("the agent's fleet does not depend on the row seed: two setups on one seed differ, and the seed-mix fleet is not the stored one", async () => {
    const a = await startFleet()
    const b = await startFleet()
    await ask(a.matchId, SETUP)
    await ask(b.matchId, SETUP)
    const fa = (await storedLog(a.matchId)).agent.slice(0, 5)
    const fb = (await storedLog(b.matchId)).agent.slice(0, 5)
    expect(fa).toHaveLength(5)
    expect(fa).not.toEqual(fb)
    // What the old seed mix would have placed, replayed the way an offline scanner would: same seed, same public agent code.
    let s = fleetCore.init(SEED)
    const derived: number[] = []
    for (let i = 0; i < 5; i++) {
      const rng = makeRng((SEED ^ Math.imul(2, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) | 0)
      const code = chooseFleetAction('easy', fleetCore.observe(s, 1) as FleetObs, rng)
      derived.push(code)
      s = fleetCore.step(s, [fleetCore.decodeAction(SETUP[i]!), fleetCore.decodeAction(code)] as never)
    }
    expect(fa).not.toEqual(derived)
    expect(fb).not.toEqual(derived)
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

  test('two identical parallel requests both get 200 with the same body and one stored action', async () => {
    const m = await startFleet()
    await ask(m.matchId, SETUP)
    const [a, b] = await Promise.all([ask(m.matchId, [...SETUP, shot(10)]), ask(m.matchId, [...SETUP, shot(10)])])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.body).toEqual(b.body)
    const log = await storedLog(m.matchId)
    expect(log.human).toEqual([...SETUP, shot(10)])
    expect(log.agent).toHaveLength(6)
  })

  test('a changed agent spec mid-match does not move agent actions already stored or shown', async () => {
    const m = await startFleet()
    await ask(m.matchId, SETUP)
    let human = [...SETUP]
    let last = bodyOf(await ask(m.matchId, human))
    for (let cell = 0; cell < 6; cell++) {
      human = [...human, shot(cell)]
      last = bodyOf(await ask(m.matchId, human))
    }
    const before = await storedLog(m.matchId)
    const incomingBefore = (last.view as FleetObs).incoming.map((x) => x.cell)
    // A deploy changes the agent while the match is open: it now answers every earlier tick with an illegal code, so any recompute would fail or differ.
    const changed = { ...FLEET_SPEC, agentAction: (level: never, seed: number, obs: unknown, seat: 0 | 1, tick: number) => (tick < before.agent.length ? 99999 : FLEET_SPEC.agentAction(level, seed, obs, seat, tick)) }
    const next = bodyOf(await sealedTurnHandler(db, { matchId: m.matchId, actions: [...human, shot(6)] }, ME, changed))
    const after = await storedLog(m.matchId)
    expect(after.agent.slice(0, before.agent.length)).toEqual(before.agent)
    expect((next.view as FleetObs).incoming.map((x) => x.cell).slice(0, incomingBefore.length)).toEqual(incomingBefore)
    // A retry of the same request under the changed spec returns the stored view too.
    const retry = bodyOf(await sealedTurnHandler(db, { matchId: m.matchId, actions: [...human, shot(6)] }, ME, changed))
    expect(retry).toEqual(next)
  })

  test('a turn keeps the other filterFlags keys (a practice match stays practice)', async () => {
    const r = await startMatchHandler(db, { sides: 1, game: 'fleet', level: 'easy', practice: true }, ME, { agentVersion: () => 'v1', seed: () => SEED })
    const id = (r.body as { matchId: string }).matchId
    await ask(id, SETUP)
    await ask(id, [...SETUP, shot(0)])
    const row = (await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!
    expect((row.filterFlags as { practice?: boolean }).practice).toBe(true)
    expect((row.filterFlags as { sealedLog?: unknown }).sealedLog).toBeDefined()
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
    // Setup is random per match; the shots are the part that must not move with the human's unhit cells.
    expect((await storedLog(b.matchId)).agent.slice(5)).toEqual((await storedLog(a.matchId)).agent.slice(5))
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
    const four = await startMatchHandler(db, { sides: 1, game: 'four', level: 'easy' }, ME, { agentVersion: () => 'v1', seed: () => 1 })
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

  test('the honest record with humanSeat 1 is invalid and moves no rating', async () => {
    const m = await startFleet()
    const { human, last } = await playOut(m.matchId)
    const rec = decodeRecord(recordOf(m.matchId, SEED, human, last.reveal!.agentActions))
    rec.humanSeat = 1
    const done = await finishMatchHandler(db, encodeRecord(rec), ME)
    expect(done.body).toMatchObject({ valid: false, reason: 'a sealed match is played from seat 0' })
    expect(await db.select().from(schema.rating)).toHaveLength(0)
  })

  test('a self-built record for a match that was never played through the server is invalid', async () => {
    const m = await startFleet()
    // Anyone who knew the seed could run the sealed log offline; the server must still not count it.
    const human = [...SETUP]
    let built = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, human)
    // The agent's fleet is random per call now, so keep the first one the way the server keeps the stored actions.
    const fleet = built.agent.slice(0, 5)
    for (let cell = 0; !fleetCore.terminal(built.state); cell++) {
      human.push(shot(cell))
      built = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, human, fleet)
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

describe('the record has to be the logged match: forged but replayable records', () => {
  /** A played-out honest match, and a record that replays cleanly end to end but is not the logged one. */
  async function forge(build: (human: number[]) => number[]) {
    const m = await startFleet()
    const { human } = await playOut(m.matchId)
    const other = build(human)
    // The agent's fleet is random per match now, so a forger who saw the reveal replays with the stored one.
    const fleet = (await storedLog(m.matchId)).agent.slice(0, 5)
    // A moved fleet can end the game earlier than the honest shots do: drop the shots left over after the end.
    let built: ReturnType<typeof buildSealedLog<FleetState>> | undefined
    while (!built) {
      try {
        built = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, other, fleet)
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes('after the game ended') || other.length <= SETUP.length) throw e
        other.pop()
      }
    }
    for (let cell = 0; !fleetCore.terminal(built.state); cell++) {
      expect(cell).toBeLessThan(100)
      if (!other.includes(shot(cell))) other.push(shot(cell))
      built = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, other, fleet)
    }
    return { m, human, done: await finishMatchHandler(db, recordOf(m.matchId, SEED, other.slice(0, built.humanUsed), built.agent), ME) }
  }

  test('a changed shot (two shots swapped) is refused with the log reason, and the row is not finished', async () => {
    const { m, human, done } = await forge((h) => {
      const x = [...h]
      ;[x[SETUP.length], x[SETUP.length + 1]] = [x[SETUP.length + 1]!, x[SETUP.length]!]
      return x
    })
    expect(human.length).toBeGreaterThan(SETUP.length + 2)
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ valid: false, reason: 'record does not match the logged turns' })
    expect(await db.select().from(schema.rating)).toHaveLength(0)
    expect((await db.select().from(schema.match).where(eq(schema.match.id, m.matchId)))[0]!.recordValid).toBe(false)
  })

  test('a moved fleet (another legal setup) is refused with the log reason', async () => {
    const { done } = await forge((h) => [...randomFleet(makeRng(8)).map(place), ...h.slice(SETUP.length)])
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ valid: false, reason: 'record does not match the logged turns' })
    expect(await db.select().from(schema.rating)).toHaveLength(0)
  })
})

describe('a sealed match that never got its setup was not played', () => {
  const USER = { userId: 'u-1' }
  const ratingGames = async () => (await db.select().from(schema.rating).where(eq(schema.rating.userId, 'u-1')))[0]?.games
  const startAs = async () => {
    const r = await startMatchHandler(db, { sides: 1, game: 'fleet', level: 'easy' }, USER, { agentVersion: () => 'v1', seed: () => SEED })
    return (r.body as { matchId: string }).matchId
  }

  test('resigning it settles the row with no rating', async () => {
    const id = await startAs()
    const r = await resignMatchHandler(db, { matchId: id, tick: 0 }, USER)
    expect(r.body).toEqual({ resigned: true, unplayed: true })
    expect(await ratingGames()).toBeUndefined()
    expect((await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!.status).toBe('resigned')
  })

  test('the abandon sweep settles it with no rating, and the open-match cap does too', async () => {
    const id = await startAs()
    await db.update(schema.match).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.match.id, id))
    expect(await abandonStale(db)).toBe(1)
    expect(await ratingGames()).toBeUndefined()
    expect((await db.select().from(schema.match).where(eq(schema.match.id, id)))[0]!.status).toBe('abandoned')
    for (let i = 0; i < 4; i++) await startAs()
    expect((await db.select().from(schema.match).where(eq(schema.match.status, 'abandoned'))).length).toBeGreaterThan(1)
    expect(await ratingGames()).toBeUndefined()
  })

  test('an abandoned unplayed row leaves no trace on the player record', async () => {
    const id = await startAs()
    await db.update(schema.match).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.match.id, id))
    expect(await abandonStale(db)).toBe(1)
    const rec = await getMyRecord(db as never, 'u-1')
    expect(rec.perGame.find((g) => g.game === 'fleet')).toBeUndefined()
    expect(rec.recent.filter((m) => m.game === 'fleet')).toHaveLength(0)
  })

  test('a stored setup with no shot is still unplayed: a reply lost twice costs nothing, and the sweep leaves competitive reads', async () => {
    expect(SEALED_SETUP_TICKS).toBe(FLEET_SPEC.setupTicks)
    const a = await startAs()
    expect((await ask(a, SETUP, USER)).status).toBe(200)
    expect((await storedLog(a)).human).toHaveLength(5)
    await db.update(schema.match).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.match.id, a))
    expect(await abandonStale(db)).toBe(1)
    expect(await ratingGames()).toBeUndefined()
    const rec = await getMyRecord(db as never, 'u-1')
    expect(rec.perGame.find((g) => g.game === 'fleet')).toBeUndefined()
    expect(rec.recent.filter((m) => m.game === 'fleet')).toHaveLength(0)
    const b = await startAs()
    expect((await ask(b, SETUP, USER)).status).toBe(200)
    await resignMatchHandler(db, { matchId: b, tick: 5 }, USER)
    expect(await ratingGames()).toBeUndefined()
  })

  test('a resign that read the row before a shot was stored is still a loss: the unplayed call is checked against the log it writes over', async () => {
    const a = await startAs()
    expect((await ask(a, SETUP, USER)).status).toBe(200)
    // The first read returns the row as it stood, then the first shot lands before the resign writes.
    let raced = false
    const racing = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'select' || raced) return Reflect.get(target, key, receiver)
        raced = true
        return () => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                const rows = await db.select().from(schema.match).where(eq(schema.match.id, a)).limit(1)
                expect((await ask(a, [...SETUP, shot(0)], USER)).status).toBe(200)
                return rows
              },
            }),
          }),
        })
      },
    })
    const r = await resignMatchHandler(racing, { matchId: a, tick: 5 }, USER)
    expect(raced).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).not.toHaveProperty('unplayed')
    expect(await ratingGames()).toBe(1)
  })

  test('once a shot is stored the match was played: resigning and abandoning still cost a loss', async () => {
    const a = await startAs()
    expect((await ask(a, SETUP, USER)).status).toBe(200)
    expect((await ask(a, [...SETUP, shot(0)], USER)).status).toBe(200)
    const resigned = await resignMatchHandler(db, { matchId: a, tick: 6 }, USER)
    expect(resigned.body).not.toHaveProperty('unplayed')
    expect(await ratingGames()).toBe(1)
    const b = await startAs()
    expect((await ask(b, SETUP, USER)).status).toBe(200)
    expect((await ask(b, [...SETUP, shot(0)], USER)).status).toBe(200)
    await db.update(schema.match).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.match.id, b))
    expect(await abandonStale(db)).toBe(1)
    expect(await ratingGames()).toBe(2)
  })
})
