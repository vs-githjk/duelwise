import { describe, expect, test } from 'bun:test'
import { SHIPS, fleetCore, shipCells, type FleetObs, type Placement } from '@duelwise/core/src/games/fleet'
import { createMatchRecorder, type FinishedMatch, type RecorderInit, type Session } from '../../lib/match-recorder'
import { recordMatchesLog } from '@duelwise/core/src/sealed-log'
import { replay } from '@duelwise/core/src/replay'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { buildSealedLog, FLEET_SPEC } from '../../server/sealed-duel'
import type { FetchTurn, FleetTurnReply } from './api'
import { createFleetEngine, recordFromLists, setupCodes, shotCode, type FleetSnapshot, type RecorderPort } from './useFleetMatch'

const SEED = 987654321
const FLEET: Placement[] = randomFleet(makeRng(7))

/** The server, without a database: the same replay the real handler does (buildSealedLog), the same refusals the engine must never trigger. */
function fakeServer(opts: { tamper?: (r: FleetTurnReply) => FleetTurnReply; failFirstOf?: number } = {}) {
  let stored: { human: number[]; agent: number[] } = { human: [], agent: [] }
  const calls: number[][] = []
  const replies: FleetTurnReply[] = []
  let failures = 0
  const fetchTurn: FetchTurn = async (_id, actions) => {
    calls.push([...actions])
    const fresh = stored.human.length === 0
    if (fresh && actions.length !== SHIPS.length) throw new Error('the first request must carry exactly 5 setup actions')
    if (!fresh && !stored.human.every((n, i) => actions[i] === n)) throw new Error('actions must be the ones already played, plus at most one new one')
    if (opts.failFirstOf !== undefined && calls.length === opts.failFirstOf && failures++ < 2) throw new Error('network down')
    const run = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, actions, stored.agent)
    stored = { human: actions, agent: run.agent }
    const over = fleetCore.terminal(run.state)
    const view = fleetCore.observe(run.state, 0)
    let reply: FleetTurnReply = JSON.parse(JSON.stringify(over ? { view, over, reveal: { seed: SEED, agentActions: run.agent } } : { view, over }))
    if (opts.tamper) reply = opts.tamper(reply)
    replies.push(reply)
    return reply
  }
  return { fetchTurn, calls, replies, stored: () => stored }
}

/** The match recorder without React, with a log of what the engine told it and when. */
function fakeRecorder(session: Session) {
  let rec: ReturnType<typeof createMatchRecorder> | null = null
  const log = { startSeed: -1, setSeedAt: [] as number[], beginLevel: null as Level | null, beginSeed: undefined as number | undefined, finished: null as FinishedMatch | null, resigned: 0, events: [] as string[] }
  const port: RecorderPort = {
    async begin(level, devSeed) {
      log.beginLevel = level
      log.beginSeed = devSeed
      return session
    },
    start(init) {
      log.startSeed = init.seed
      rec = createMatchRecorder({ ...init, game: 'fleet', matchId: 'm-1', device: 'desktop', input: 'mouse' } as RecorderInit)
    },
    act: (tick, seat, action, ms) => rec!.recordAction(tick, seat, action, ms),
    reach() {},
    setSeed(seed) {
      log.setSeedAt.push(log.events.length)
      rec!.setSeed(seed)
    },
    async finish(core, state) {
      log.finished = await rec!.finish(core, state)
      return log.finished
    },
    async resign() {
      log.resigned++
    },
  }
  return { port, log }
}

const SEALED: Session = { seed: 0, matchId: 'm-1', agentVersion: 'v1', rated: true, sealed: true }
const UNRATED: Session = { seed: 4242, rated: false, unratedReason: 'This match used a fixed test seed, so it is not counted.' }

function engineFor(session: Session, server: ReturnType<typeof fakeServer>) {
  const r = fakeRecorder(session)
  const snaps: FleetSnapshot[] = []
  const engine = createFleetEngine({ recorder: () => r.port, fetchTurn: server.fetchTurn, hold: 0, onChange: (s) => snaps.push(s), trainingAllowed: false })
  return { engine, snaps, ...r }
}

/** Fires at the first cell not yet fired until the match is over (or a cap); returns how many shots it took. */
async function playOut(engine: ReturnType<typeof createFleetEngine>) {
  let n = 0
  for (let cell = 0; engine.snapshot().phase === 'play' && cell < 100; cell++) {
    const fired = new Set(engine.snapshot().view!.shots.map((s) => s.cell))
    if (fired.has(cell)) continue
    await engine.fire(cell)
    n++
    if (engine.snapshot().failure) break
  }
  return n
}

describe('counted match through the engine', () => {
  test('the first request is the five setup actions, every later one adds exactly one shot, and setup is never sent twice', async () => {
    const server = fakeServer()
    const { engine } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    expect(engine.snapshot().phase).toBe('play')
    expect(server.calls[0]).toEqual(setupCodes(FLEET))
    await playOut(engine)
    expect(engine.snapshot().phase).toBe('over')
    const setup = setupCodes(FLEET)
    const first = server.calls.filter((c) => c.length === SHIPS.length)
    expect(first).toHaveLength(1)
    server.calls.slice(1).forEach((c, i) => {
      expect(c.slice(0, SHIPS.length)).toEqual(setup)
      expect(c).toHaveLength(SHIPS.length + i + 1)
      expect(c.slice(SHIPS.length).every((n) => n >= 200 && n < 300)).toBe(true)
      if (i > 0) expect(c.slice(0, c.length - 1)).toEqual(server.calls[i])
    })
  })

  test('the view holds no enemy cell before it is hit or sunk, and no reveal, seed or opponent action until the end', async () => {
    const server = fakeServer()
    const { engine, snaps, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await playOut(engine)
    const final = engine.snapshot()
    expect(final.phase).toBe('over')
    const enemy = recordFromLists(SEED, server.stored().human, server.stored().agent).state.ships[1]
    const enemyCells = new Set(enemy.flatMap((p) => shipCells(p)))
    expect(enemyCells.size).toBe(17)
    for (const s of snaps.filter((x) => x.phase !== 'over' && x.view)) {
      const v = s.view as FleetObs
      expect(v.reveal).toBeNull()
      const hits = new Set(v.shots.filter((m) => m.hit).map((m) => m.cell))
      // Every enemy ship the view shows is a sunk one: all of its cells were hit by me.
      for (const p of v.sunk) for (const c of shipCells(p)) expect(hits.has(c)).toBe(true)
      // Any enemy ship that is not sunk is not in the view, and not every one of its cells was hit.
      const sunkIds = new Set(v.sunk.map((p) => p.id))
      for (const p of enemy) if (!sunkIds.has(p.id)) expect(shipCells(p).every((c) => hits.has(c))).toBe(false)
      expect(JSON.stringify(s)).not.toMatch(/agentActions|"seed"/)
    }
    // Replies carry the reveal only on the last one.
    expect(server.replies.slice(0, -1).every((r) => r.reveal === undefined && !r.over)).toBe(true)
    expect(server.replies.at(-1)!.reveal).toBeDefined()
    // The recorder started with seed 0 and learned the real one once, after the last reply.
    expect(log.startSeed).toBe(0)
    expect(log.setSeedAt).toHaveLength(1)
    expect(final.view!.reveal).not.toBeNull()
  })

  test('the finished record replays, and the server log accepts it', async () => {
    const server = fakeServer()
    const { engine, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await playOut(engine)
    const rec = log.finished!
    expect(rec.ok).toBe(true)
    expect(rec.record.seed).toBe(SEED)
    expect(rec.record.humanSeat).toBe(0)
    expect(replay(rec.record).ok).toBe(true)
    expect(recordMatchesLog(rec.record, { sealedLog: server.stored() })).toBe(true)
    // The human's shots carry think times; the setup placements do not.
    expect(rec.record.humanInputTimesMs).toHaveLength(server.stored().human.length - SHIPS.length)
  })

  test('a changed shot or a moved fleet in the record is not the logged match', async () => {
    const server = fakeServer()
    const { engine, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await playOut(engine)
    const honest = log.finished!.record
    const flags = { sealedLog: server.stored() }
    const lastMine = honest.actions.map((a) => a[1]).lastIndexOf(0)
    const otherShot = { ...honest, actions: honest.actions.map((a, i) => (i === lastMine ? ([a[0], a[1], a[2] === 299 ? 298 : a[2] + 1] as typeof a) : a)) }
    const moved = { ...honest, actions: honest.actions.map((a) => (a[0] === 0 && a[1] === 0 ? ([a[0], a[1], a[2] === 0 ? 1 : 0] as typeof a) : a)) }
    expect(recordMatchesLog(otherShot, flags)).toBe(false)
    expect(recordMatchesLog(moved, flags)).toBe(false)
    expect(recordMatchesLog({ ...honest, actions: honest.actions.slice(0, -1) }, flags)).toBe(false)
  })

  test('a server that reveals actions which are not the played match is refused and nothing is recorded as finished', async () => {
    const server = fakeServer({ tamper: (r) => (r.reveal ? { ...r, reveal: { ...r.reveal, agentActions: r.reveal.agentActions.slice(0, -1) } } : r) })
    const { engine, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await playOut(engine)
    expect(log.finished).toBeNull()
    expect(engine.snapshot().phase).not.toBe('over')
    expect(engine.snapshot().failure).toMatch(/does not add up/)
  })

  test('a dropped reply is retried with the same request and the match goes on', async () => {
    const server = fakeServer({ failFirstOf: 4 })
    const { engine } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await playOut(engine)
    expect(engine.snapshot().phase).toBe('over')
    // The first attempt of the fourth request failed; the engine sent the same request again and the page saw no failure.
    expect(engine.snapshot().failure).toBeNull()
  })

  test('resigning a counted match tells the recorder once and ends the match with no record', async () => {
    const server = fakeServer()
    const { engine, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await engine.fire(0)
    await engine.resign()
    expect(engine.snapshot().phase).toBe('over')
    expect(engine.snapshot().resigned).toBe(true)
    expect(log.resigned).toBe(1)
    expect(log.finished).toBeNull()
    expect(await engine.fire(5)).toBeNull()
  })

  test('a shot the page already fired is refused before anything is sent', async () => {
    const server = fakeServer()
    const { engine } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await engine.fire(10)
    const before = server.calls.length
    if (engine.snapshot().phase === 'play') {
      expect(await engine.fire(10)).toBe('You already fired there')
      expect(server.calls).toHaveLength(before)
    }
    expect(shotCode(10)).toBe(210)
  })
})

describe('unrated match through the engine', () => {
  test('plays on the local core, never calls the server, and records a match that replays', async () => {
    const server = fakeServer()
    const { engine, log } = engineFor(UNRATED, server)
    await engine.start('easy', FLEET, 4242)
    expect(log.beginSeed).toBe(4242)
    await playOut(engine)
    expect(engine.snapshot().phase).toBe('over')
    expect(engine.snapshot().sealed).toBe(false)
    expect(server.calls).toHaveLength(0)
    expect(log.startSeed).toBe(4242)
    expect(log.finished!.ok).toBe(true)
    expect(replay(log.finished!.record).ok).toBe(true)
  })

  test('resigning an unrated match ends it without a record', async () => {
    const { engine, log } = engineFor(UNRATED, fakeServer())
    await engine.start('easy', FLEET, 4242)
    await engine.resign()
    expect(engine.snapshot().phase).toBe('over')
    expect(engine.snapshot().resigned).toBe(true)
    expect(log.resigned).toBe(1)
    expect(log.finished).toBeNull()
  })
})

describe('recordFromLists', () => {
  test('refuses a list with an action left over or missing', async () => {
    const server = fakeServer()
    const { engine } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await playOut(engine)
    const { human, agent } = server.stored()
    expect(() => recordFromLists(SEED, human, agent)).not.toThrow()
    expect(() => recordFromLists(SEED, [...human, 250], agent)).toThrow()
    expect(() => recordFromLists(SEED, human.slice(0, -1), agent)).toThrow()
    expect(() => recordFromLists(SEED, human, [...agent, 3])).toThrow()
  })
})
