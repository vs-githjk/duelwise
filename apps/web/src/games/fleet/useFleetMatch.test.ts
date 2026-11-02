import { describe, expect, test } from 'bun:test'
import { SHIPS, fleetCore, shipCells, type FleetObs, type Placement } from '@duelwise/core/src/games/fleet'
import { createMatchRecorder, type FinishedMatch, type RecorderInit, type Session } from '../../lib/match-recorder'
import { recordMatchesLog } from '@duelwise/core/src/sealed-log'
import { replay } from '@duelwise/core/src/replay'
import { makeRng } from '@duelwise/core/src/rng'
import type { Level } from '@duelwise/core/src/product'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { buildSealedLog, FLEET_SPEC } from '../../server/sealed-duel'
import { TurnRefused, type FetchTurn, type FleetTurnReply } from './api'
import { createFleetEngine, recordFromLists, setupCodes, MATCH_ENDED, SETUP_FAILED, shotFailed, shotCode, type FleetSnapshot, type RecorderPort } from './useFleetMatch'

const SEED = 987654321
const FLEET: Placement[] = randomFleet(makeRng(7))

/** The server, without a database: the same replay the real handler does (buildSealedLog), the same refusals the engine must never trigger. */
function fakeServer(opts: { tamper?: (r: FleetTurnReply) => FleetTurnReply; failFirstOf?: number; loseReplyAt?: number; refuseAt?: number } = {}) {
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
    // The request never reaches the server.
    if (opts.refuseAt !== undefined && (calls.length === opts.refuseAt || calls.length === opts.refuseAt + 1)) throw new Error('network down')
    const run = buildSealedLog(FLEET_SPEC, fleetCore, 'easy', SEED, actions, stored.agent)
    stored = { human: actions, agent: run.agent }
    const over = fleetCore.terminal(run.state)
    const view = fleetCore.observe(run.state, 0)
    let reply: FleetTurnReply = JSON.parse(JSON.stringify(over ? { view, over, reveal: { seed: SEED, agentActions: run.agent } } : { view, over }))
    if (opts.tamper) reply = opts.tamper(reply)
    // The server stored the action but the reply is lost, on this request and on the engine's one retry.
    if (opts.loseReplyAt !== undefined && (calls.length === opts.loseReplyAt || calls.length === opts.loseReplyAt + 1)) throw new Error('reply lost')
    replies.push(reply)
    return reply
  }
  return { fetchTurn, calls, replies, stored: () => stored }
}

/** The match recorder without React, with a log of what the engine told it and when. */
function fakeRecorder(session: Session) {
  let rec: ReturnType<typeof createMatchRecorder> | null = null
  const log = { discards: 0, startSeed: -1, setSeedAt: [] as number[], beginLevel: null as Level | null, beginSeed: undefined as number | undefined, finished: null as FinishedMatch | null, resigned: 0, events: [] as string[] }
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
    discard() {
      log.discards++
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

  test('a shot whose reply was lost twice is sent again as it was, whatever cell is tapped next, and the match goes on with no 409', async () => {
    // Request 1 is the setup, request 2 the first shot: the server stores it and the reply is lost on both tries.
    const server = fakeServer({ loseReplyAt: 2 })
    const { engine } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    expect(await engine.fire(10)).toBeNull()
    expect(engine.snapshot().failure).toBe(shotFailed(10))
    expect(engine.snapshot().failure).toBe('Shot at A2 not sent. Press Fire to send it again.')
    // The lost square is named and kept for the page to hold aimed and locked.
    expect(engine.snapshot().unsentCell).toBe(10)
    expect(engine.snapshot().thinking).toBe(false)
    expect(engine.snapshot().view!.shots).toHaveLength(0)
    expect(server.stored().human).toEqual([...setupCodes(FLEET), shotCode(10)])
    // A different cell now: the engine resends the stored list and applies its reply.
    expect(await engine.fire(55)).toBeNull()
    const snap = engine.snapshot()
    expect(snap.failure).toBeNull()
    expect(snap.unsentCell).toBeNull()
    expect(snap.view!.shots.map((x) => x.cell)).toEqual([10])
    expect(server.stored().human).toHaveLength(SHIPS.length + 1)
    // Confirmed: the next shot builds on it.
    expect(await engine.fire(55)).toBeNull()
    expect(engine.snapshot().view!.shots.map((x) => x.cell)).toEqual([10, 55])
    expect(engine.snapshot().failure).toBeNull()
    await playOut(engine)
    expect(engine.snapshot().phase).toBe('over')
  })

  test('resigning after a lost shot clears the lost square, so the over screen keeps no aim', async () => {
    const { engine, snaps } = engineFor(SEALED, fakeServer({ loseReplyAt: 2 }))
    await engine.start('easy', FLEET)
    await engine.fire(10)
    expect(engine.snapshot().unsentCell).toBe(10)
    await engine.resign()
    // What the page sees is what the engine emitted, not what it holds silently.
    expect(snaps.at(-1)).toMatchObject({ phase: 'over', resigned: true, unsentCell: null, failure: null })
  })

  test('a request that fails twice shows plain copy, never the server text, and the line goes with the next good reply', async () => {
    const server = fakeServer({ refuseAt: 2 })
    const { engine } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await engine.fire(10)
    expect(engine.snapshot().failure).toBe(shotFailed(10))
    expect(JSON.stringify(engine.snapshot())).not.toMatch(/network down|actions must be/)
    await engine.fire(10)
    expect(engine.snapshot().failure).toBeNull()
    expect(engine.snapshot().view!.shots.map((x) => x.cell)).toEqual([10])
  })

  test('a server refusal of a shot is final: no retry, no unsent shot, and the page says the match ended and returns to setup', async () => {
    const server = fakeServer()
    const refusing: FetchTurn = async (id, actions) => {
      if (actions.length > SHIPS.length) throw new TurnRefused('match is already abandoned')
      return server.fetchTurn(id, actions)
    }
    const r = fakeRecorder(SEALED)
    const engine = createFleetEngine({ recorder: () => r.port, fetchTurn: refusing, hold: 0, onChange: () => {}, trainingAllowed: false })
    await engine.start('easy', FLEET)
    expect(engine.snapshot().phase).toBe('play')
    expect(await engine.fire(10)).toBeNull()
    const snap = engine.snapshot()
    expect(snap.phase).toBe('setup')
    expect(snap.failure).toBe(MATCH_ENDED)
    expect(snap.thinking).toBe(false)
    expect(server.calls).toHaveLength(1)
    expect(r.log.discards).toBe(1)
    // A new match starts clean: the refused shot is not resent.
    await engine.start('easy', FLEET)
    expect(engine.snapshot().phase).toBe('play')
    expect(server.calls.at(-1)).toEqual(setupCodes(FLEET))
  })

  test('a setup request that fails twice returns to setup with plain copy and tells the recorder to drop the match', async () => {
    const server = fakeServer({ refuseAt: 1 })
    const { engine, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    const snap = engine.snapshot()
    expect(snap.phase).toBe('setup')
    expect(snap.failure).toBe(SETUP_FAILED)
    expect(log.discards).toBe(1)
    expect(log.resigned).toBe(0)
    // Start match again starts a fresh match.
    await engine.start('easy', FLEET)
    expect(engine.snapshot().phase).toBe('play')
    expect(engine.snapshot().failure).toBeNull()
  })

  test('resigning a counted match tells the recorder once and ends the match with no record', async () => {
    const server = fakeServer()
    const { engine, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await engine.fire(0)
    await engine.resign()
    expect(engine.snapshot().failure).toBeNull()
    expect(engine.snapshot().phase).toBe('over')
    expect(engine.snapshot().resigned).toBe(true)
    expect(log.resigned).toBe(1)
    expect(log.finished).toBeNull()
    expect(await engine.fire(5)).toBeNull()
  })

  test('no record exists until the server says the match is over: a dropped, refused or plain shot writes none, so a mid-match upload is never from this page', async () => {
    const server = fakeServer({ loseReplyAt: 3 })
    const { engine, log } = engineFor(SEALED, server)
    await engine.start('easy', FLEET)
    await engine.fire(0)
    expect(log.finished).toBeNull()
    await engine.fire(1)
    expect(engine.snapshot().failure).toBe(shotFailed(1))
    expect(log.finished).toBeNull()
    await playOut(engine)
    expect(engine.snapshot().phase).toBe('over')
    expect(server.replies.at(-1)!.over).toBe(true)
    expect(log.finished).not.toBeNull()
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
