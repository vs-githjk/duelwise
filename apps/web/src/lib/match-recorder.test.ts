import { describe, expect, test } from 'bun:test'
import { decodeRecord, encodeRecord } from '@duelwise/core/src/match-record'
import { replay } from '@duelwise/core/src/replay'
import { createCounterGame, createDriftGame } from '@duelwise/core/src/testing/counter-game'
import { openMatch } from './open-match'
import { listPending, retryPending, savePending, type KeyValueStore } from './integrity'
import { beginSession, createMatchRecorder, offlineReason, uploadMatch, type MatchApi, type RecorderInit } from './match-recorder'

const clock = () => {
  let t = Date.UTC(2026, 9, 21, 12, 0, 0)
  return () => new Date((t += 1000))
}

function init(over: Partial<RecorderInit> = {}): RecorderInit {
  return {
    game: 'four',
    matchId: 'm-1',
    seed: 7,
    humanSeat: 0,
    agent: { version: 'v0', level: 'easy' },
    trainingAllowed: true,
    device: 'desktop',
    input: 'mouse',
    now: clock(),
    ...over,
  }
}

/** Plays the counter game to the end: the human (seat 0) always adds 3, the agent always adds 1. */
function playCounter(rec: ReturnType<typeof createMatchRecorder>, game: RecorderInit['game'] = 'four') {
  const core = createCounterGame(game)
  let s = core.init(7)
  let tick = 0
  while (!core.terminal(s)) {
    const seat = core.toAct(s)[0]!
    const a = seat === 0 ? 3 : 1
    rec.recordAction(tick, seat, a, seat === 0 ? 420 + tick : undefined)
    s = core.step(s, seat === 0 ? [a, null] : [null, a])
    tick++
  }
  return { core, s }
}

describe('createMatchRecorder', () => {
  test('a counter-game match records and replays to its final hash', async () => {
    const rec = createMatchRecorder(init())
    const { core, s } = playCounter(rec)
    const out = await rec.finish(core, s)
    expect(out.ok).toBe(true)
    expect(out.record.finalHash).toBe(core.hash(s))
    expect(out.record.result).toEqual(core.result(s)!)
    expect(out.record.humanInputTimesMs!.length).toBeGreaterThan(0)
    expect(replay(out.record, { core }).ok).toBe(true)
    expect(out.bytes.length).toBeGreaterThan(18)
    expect(decodeRecord(out.bytes)).toEqual(out.record)
    expect(decodeRecord(encodeRecord(out.record)).matchId).toBe('m-1')
  })

  test('an edited action fails replay', async () => {
    const rec = createMatchRecorder(init())
    const { core, s } = playCounter(rec)
    const out = await rec.finish(core, s)
    const edited = structuredClone(out.record)
    edited.actions[0]![2] = 1
    expect(replay(edited, { core }).ok).toBe(false)
  })

  test('finish reports a recording that does not match the played game', async () => {
    const rec = createMatchRecorder(init())
    const core = createCounterGame('four')
    let s = core.init(7)
    let tick = 0
    while (!core.terminal(s)) {
      const seat = core.toAct(s)[0]!
      rec.recordAction(tick, seat, 2) // records 2 ...
      s = core.step(s, seat === 0 ? [3, null] : [null, 1]) // ... but plays 3 and 1
      tick++
    }
    const out = await rec.finish(core, s)
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
  })

  test('finish refuses a game that has not ended', async () => {
    const rec = createMatchRecorder(init())
    const core = createCounterGame('four')
    await expect(rec.finish(core, core.init(7))).rejects.toThrow(/not finished/)
  })

  test('realtime recording keeps only frames where the input changed', async () => {
    const rec = createMatchRecorder(init({ game: 'fighter', input: 'keyboard' }))
    const core = createDriftGame('fighter')
    let s = core.init(7)
    const script = (frame: number): [number, number] => [frame < 3 ? 2 : frame < 6 ? 1 : 2, 1]
    for (let f = 0; !core.terminal(s); f++) {
      const [a, b] = script(f)
      rec.recordAction(f, 0, a)
      rec.recordAction(f, 1, b)
      s = core.step(s, [a, b])
    }
    const out = await rec.finish(core, s)
    expect(out.ok).toBe(true)
    expect(out.record.actions.filter((x) => x[1] === 1).length).toBe(1)
    expect(out.record.actions.filter((x) => x[1] === 0).map((x) => x[0])).toEqual([0, 3, 6])
  })

  test('the record carries the init fields and the training flag', async () => {
    const rec = createMatchRecorder(init({ trainingAllowed: false, device: 'phone', input: 'touch' }))
    const { core, s } = playCounter(rec)
    const { record } = await rec.finish(core, s)
    expect(record).toMatchObject({ schema: 1, game: 'four', seed: 7, humanSeat: 0, trainingAllowed: false, device: 'phone', input: 'touch', coreVersion: 'counter-1' })
    expect(record.agent).toEqual({ version: 'v0', level: 'easy' })
    expect(Date.parse(record.endedAt)).toBeGreaterThan(Date.parse(record.startedAt))
  })
})

function fakeApi(over: Partial<MatchApi> = {}): MatchApi & { sent: Uint8Array[]; started: Array<{ game: string; level: string; practice?: boolean }> } {
  const sent: Uint8Array[] = []
  const started: Array<{ game: string; level: string; practice?: boolean }> = []
  return {
    sent,
    started,
    async start(i) {
      started.push(i)
      return { matchId: 'srv-1', seed: 7, agentVersion: 'v9' }
    },
    async finish(bytes) {
      sent.push(bytes)
      return { valid: true, result: null, elo: { before: 1000, after: 1020 }, provisional: true }
    },
    ...over,
  }
}

describe('beginSession and uploadMatch (every game goes through the same path)', () => {
  for (const game of ['four', 'word', 'chess'] as const) {
    test(`${game}: the seed comes from startMatch and the replay-checked record is uploaded`, async () => {
      const api = fakeApi()
      const s = await beginSession(api, game, 'medium')
      expect(api.started).toEqual([{ game, level: 'medium' }])
      expect(s).toMatchObject({ seed: 7, matchId: 'srv-1', rated: true })
      const rec = createMatchRecorder(init({ game, matchId: s.matchId!, seed: s.seed }))
      const { core, s: end } = playCounter(rec, game)
      const done = await rec.finish(core, end)
      const up = await uploadMatch(api, done)
      expect(api.sent).toEqual([done.bytes])
      expect(decodeRecord(api.sent[0]!).game).toBe(game)
      expect(up).toEqual({ status: 'counted', matchId: done.record.matchId, elo: { before: 1000, after: 1020 }, provisional: true })
    })
  }

  test('a practice start tells the server, and the session is marked practice', async () => {
    const api = fakeApi()
    const s = await beginSession(api, 'chess', 'hard', undefined, undefined, undefined, undefined, true)
    expect(api.started).toEqual([{ game: 'chess', level: 'hard', practice: true }])
    expect(s).toMatchObject({ matchId: 'srv-1', rated: true, practice: true })
    const rated = await beginSession(fakeApi(), 'chess', 'hard')
    expect(rated.practice).toBeUndefined()
  })

  test('a practice match never takes an offline ticket (a ticket is issued as a rated match); it plays here, unsaved', async () => {
    const down = fakeApi({ start: async () => Promise.reject(new Error('offline')) })
    let asked = false
    const ticket = { owner: { userId: null, guestId: 'g-1' }, matchId: 'tk-1', game: 'four' as const, level: 'easy' as const, seed: 99, agentVersion: 'v7', expiresAt: Date.now() + 1000 }
    const s = await beginSession(down, 'four', 'easy', undefined, async () => { asked = true; return ticket }, undefined, undefined, true)
    expect(asked).toBe(false)
    expect(s).toMatchObject({ rated: false, practice: true })
    expect(s.matchId).toBeUndefined()
    expect(s.unratedReason).toMatch(/Practice, not rated/)
  })

  test('a ?seed makes an unrated match and never calls the server', async () => {
    const api = fakeApi()
    const s = await beginSession(api, 'word', 'easy', 123)
    expect(s).toMatchObject({ seed: 123, rated: false })
    expect(s.matchId).toBeUndefined()
    expect(api.started).toEqual([])
  })

  test('an unreachable server uses a saved offline ticket: the match stays counted, with the ticket id, seed and version', async () => {
    const down = fakeApi({ start: async () => Promise.reject(new Error('offline')) })
    const ticket = { owner: { userId: null, guestId: 'g-1' }, matchId: 'tk-1', game: 'four' as const, level: 'easy' as const, seed: 99, agentVersion: 'v7', expiresAt: Date.now() + 1000 }
    const s = await beginSession(down, 'four', 'easy', undefined, async () => ticket)
    expect(s).toMatchObject({ seed: 99, matchId: 'tk-1', agentVersion: 'v7', rated: true, offline: true })
  })

  test('an unreachable server with no ticket left plays unrated and says why', async () => {
    const down = fakeApi({ start: async () => Promise.reject(new Error('offline')) })
    const s = await beginSession(down, 'four', 'easy', undefined, async () => null)
    expect(s.rated).toBe(false)
    expect(s.matchId).toBeUndefined()
  })

  test('offline Word Duel plays unranked on this device; other games say how to get saved match slots', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
    try {
      expect(offlineReason('word')).toMatch(/unranked/)
      expect(offlineReason('word')).toMatch(/this device only/)
      expect(offlineReason('four')).toMatch(/offline/)
      expect(offlineReason('four')).toMatch(/while online/)
    } finally {
      if (real) Object.defineProperty(globalThis, 'navigator', real)
    }
  })

  test('Word Duel never takes a ticket: its seed stays on the server, so offline it plays unranked', async () => {
    const down = fakeApi({ start: async () => Promise.reject(new Error('offline')) })
    const s = await beginSession(down, 'word', 'easy', undefined, async () => null)
    expect(s).toMatchObject({ rated: false })
    expect(s.sealed).toBeUndefined()
    expect(Number.isInteger(s.seed)).toBe(true)
  })

  test('an unreachable server gives a local seed, unrated, with a reason', async () => {
    const s = await beginSession(fakeApi({ start: async () => Promise.reject(new Error('offline')) }), 'four', 'easy')
    expect(s.rated).toBe(false)
    expect(s.unratedReason).toMatch(/not counted/)
    expect(Number.isInteger(s.seed)).toBe(true)
  })

  test('a record that did not replay is still sent, so the server can settle the row as invalid instead of leaving it started', async () => {
    let calls = 0
    const api = fakeApi({ finish: async () => { calls++; return { valid: false, reason: 'replay failed', result: null } } })
    const up = await uploadMatch(api, { record: {} as never, bytes: new Uint8Array(20), ok: false, error: 'hash differs' })
    expect(up).toEqual({ status: 'rejected', reason: 'replay failed' })
    expect(calls).toBe(1)
  })

  test('the server saying invalid is rejected; a failing upload retries once then reports failed', async () => {
    const bytes = new Uint8Array(20)
    const f = { record: {} as never, bytes, ok: true }
    expect(await uploadMatch(fakeApi({ finish: async () => ({ valid: false, reason: 'seed', result: null }) }), f)).toEqual({ status: 'rejected', reason: 'seed' })
    let calls = 0
    const flaky = fakeApi({ finish: async () => { calls++; throw new Error('net') } })
    expect(await uploadMatch(flaky, f)).toEqual({ status: 'failed', message: 'net' })
    expect(calls).toBe(2)
  })
})

function fakeStore(): KeyValueStore {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

describe('a finished match is never left started', () => {
  test('a record whose upload failed is kept, and the next load delivers it and drops it', async () => {
    const store = fakeStore()
    const bytes = new Uint8Array(40_000).map((_, i) => i % 251)
    savePending('m-9', bytes, store)
    expect(listPending(store).map((p) => p.matchId)).toEqual(['m-9'])
    expect(listPending(store)[0]!.bytes).toEqual(bytes)
    // offline: kept
    expect(await retryPending(store, (async () => { throw new Error('offline') }) as never)).toBe(0)
    // 5xx: kept
    expect(await retryPending(store, (async () => new Response('x', { status: 503 })) as never)).toBe(0)
    expect(listPending(store).length).toBe(1)
    // server answers (200, or 409 already settled): dropped
    const sent: Uint8Array[] = []
    const ok = (async (_u: string, init: RequestInit) => { sent.push(init.body as Uint8Array); return new Response('{}', { status: 200 }) }) as never
    expect(await retryPending(store, ok)).toBe(1)
    expect(sent[0]).toEqual(bytes)
    expect(listPending(store).length).toBe(0)
  })
})

describe('openMatch (leaving the page while a match is starting)', () => {
  const agent = () => { const a = { disposed: false, dispose() { a.disposed = true } }; return a }

  test('unmounted before the opponent is ready: no server row is ever requested', async () => {
    const api = fakeApi()
    let current = true
    let release!: (a: ReturnType<typeof agent>) => void
    const a = agent()
    const p = openMatch({
      create: () => new Promise<ReturnType<typeof agent>>((r) => { release = r }),
      begin: () => beginSession(api, 'chess', 'easy'),
      isCurrent: () => current,
    })
    current = false // the page unmounted
    release(a)
    expect(await p).toEqual({ kind: 'stale' })
    expect(api.started).toEqual([])
    expect(a.disposed).toBe(true)
  })

  test('left during the row round trip: the new row is given up at once', async () => {
    let current = true
    const given: string[] = []
    const a = agent()
    const api = fakeApi({ start: async () => { current = false; return { matchId: 'srv-2', seed: 5, agentVersion: 'v1' } } })
    const out = await openMatch({
      create: async () => a,
      begin: () => beginSession(api, 'chess', 'easy'),
      isCurrent: () => current,
      giveUp: (id) => given.push(id),
    })
    expect(out).toEqual({ kind: 'stale' })
    expect(given).toEqual(['srv-2'])
    expect(a.disposed).toBe(true)
  })

  test('still current: returns the opponent and the session', async () => {
    const a = agent()
    const out = await openMatch({ create: async () => a, begin: () => beginSession(fakeApi(), 'four', 'easy'), isCurrent: () => true })
    expect(out).toMatchObject({ kind: 'ok', agent: a, session: { matchId: 'srv-1', rated: true } })
  })

  test('an opponent that fails to start reports it without touching the server', async () => {
    const api = fakeApi()
    const out = await openMatch({ create: async () => { throw new Error('worker') }, begin: () => beginSession(api, 'four', 'easy'), isCurrent: () => true })
    expect(out.kind).toBe('agent-failed')
    expect(api.started).toEqual([])
  })
})
