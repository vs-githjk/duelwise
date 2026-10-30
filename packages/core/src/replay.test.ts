import { describe, expect, test } from 'bun:test'
import { replay } from './replay'
import type { MatchRecordV1 } from './match-record'
import { createCounterGame, createDriftGame } from './testing/counter-game'
import { makeRng } from './rng'
import { hashState } from './hash'

const counter = createCounterGame('four')
const drift = createDriftGame('fighter')

function playCounter(seed: number): MatchRecordV1 {
  const rng = makeRng(seed ^ 0x5eed)
  let s = counter.init(seed)
  const actions: MatchRecordV1['actions'] = []
  let tick = 0
  while (!counter.terminal(s)) {
    const seat = counter.toAct(s)[0]!
    const a = counter.legal(s, seat)[rng.int(3)]!
    actions.push([tick, seat, counter.encodeAction(a)])
    s = counter.step(s, seat === 0 ? [a, null] : [null, a])
    tick++
  }
  return {
    schema: 1, matchId: 'm', game: 'four', coreVersion: counter.version,
    agent: { version: 'v1', level: 'easy' }, seed, humanSeat: 0, actions,
    result: counter.result(s)!, finalHash: counter.hash(s),
    startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true,
  }
}

describe('replay, turn-based toy game', () => {
  test('a valid record replays ok with the same hash and result', () => {
    const r = playCounter(5)
    const out = replay(r, { core: counter })
    expect(out.error).toBeUndefined()
    expect(out.ok).toBe(true)
    expect(out.finalHash).toBe(r.finalHash)
    expect(out.result).toEqual(r.result)
  })

  test('an edited action fails with a reason', () => {
    const r = playCounter(5)
    const a = r.actions[0]!
    r.actions[0] = [a[0], a[1], a[2] === 1 ? 2 : 1]
    const out = replay(r, { core: counter })
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
  })

  test('an illegal action is named', () => {
    const r = playCounter(5)
    r.actions[0] = [0, 0, 9]
    const out = replay(r, { core: counter })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/illegal/i)
  })

  test('an edited result fails', () => {
    const r = playCounter(5)
    r.result = { ...r.result, winner: r.result.winner === 0 ? 1 : 0 }
    const out = replay(r, { core: counter })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/result/i)
  })

  test('an edited final hash fails', () => {
    const r = playCounter(5)
    r.finalHash = '0000000000000000'
    const out = replay(r, { core: counter })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/hash/i)
    expect(out.finalHash).not.toBe('0000000000000000')
  })

  test('a wrong seed fails', () => {
    const r = playCounter(5)
    r.seed = 6
    expect(replay(r, { core: counter }).ok).toBe(false)
  })

  test('a truncated record fails (game not finished)', () => {
    const r = playCounter(5)
    r.actions.pop()
    const out = replay(r, { core: counter })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/end|terminal|finish/i)
  })

  test('extra actions after the game ends fail', () => {
    const r = playCounter(5)
    r.actions.push([r.actions.length, 0, 1])
    const out = replay(r, { core: counter })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/after/i)
  })

  test('an action for the wrong seat fails', () => {
    const r = playCounter(5)
    const a = r.actions[0]!
    r.actions[0] = [a[0], 1, a[2]]
    expect(replay(r, { core: counter }).ok).toBe(false)
  })

  test('out-of-order ticks fail', () => {
    const r = playCounter(5)
    r.actions = [r.actions[1]!, r.actions[0]!, ...r.actions.slice(2)]
    expect(replay(r, { core: counter }).ok).toBe(false)
  })

  test('record for an unbuilt game fails without throwing', () => {
    const r = playCounter(5)
    const out = replay({ ...r, game: 'chess' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/chess/)
  })

  test('core version mismatch fails', () => {
    const r = playCounter(5)
    const out = replay({ ...r, coreVersion: 'other' }, { core: counter })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/version/i)
  })
})

describe('replay, realtime toy game (input changes only, held between)', () => {
  function record(): MatchRecordV1 {
    // seat 0 holds right (2) from frame 0 and wins at frame 5; seat 1 holds left (0) from frame 2 then stays (1) from frame 4.
    const actions: MatchRecordV1['actions'] = [[0, 0, 2], [0, 1, 1], [2, 1, 0], [4, 1, 1]]
    let s = drift.init(0)
    let held: [number, number] = [1, 1]
    let tick = 0
    while (!drift.terminal(s)) {
      for (const [t, seat, a] of actions) if (t === tick) held[seat] = a
      s = drift.step(s, [held[0], held[1]])
      tick++
    }
    return {
      schema: 1, matchId: 'm', game: 'fighter', coreVersion: drift.version,
      agent: { version: 'v1', level: 'hard' }, seed: 0, humanSeat: 0, actions,
      result: drift.result(s)!, finalHash: drift.hash(s),
      startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z',
      device: 'desktop', input: 'keyboard', trainingAllowed: false,
    }
  }

  test('valid realtime record replays ok', () => {
    const r = record()
    const out = replay(r, { core: drift })
    expect(out.error).toBeUndefined()
    expect(out.ok).toBe(true)
    expect(out.finalHash).toBe(r.finalHash)
  })

  test('editing one input change breaks the hash', () => {
    const r = record()
    r.actions[2] = [3, 1, 0]
    expect(replay(r, { core: drift }).ok).toBe(false)
  })

  test('a runaway sim is capped by maxTicks', () => {
    const r = record()
    r.actions = [[0, 0, 1], [0, 1, 1]]
    const out = replay(r, { core: drift, maxTicks: 50 })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/tick/i)
  })
})

describe('replay, turn game with automatic steps', () => {
  // Phases: 0 seat 0 acts, 1 automatic step, 2 seat 1 acts, 3 automatic step, 4 terminal.
  type S = { phase: number; log: number[] }
  const auto = {
    id: 'four',
    version: 'auto-1',
    init: (): S => ({ phase: 0, log: [] }),
    toAct: (s: S) => (s.phase === 0 ? [0] : s.phase === 2 ? [1] : []),
    legal: (s: S, seat: number) => ((s.phase === 0 && seat === 0) || (s.phase === 2 && seat === 1) ? [1] : []),
    step: (s: S, a: [number | null, number | null]): S => ({
      phase: s.phase + 1,
      log: [...s.log, a[0] ?? -1, a[1] ?? -1],
    }),
    terminal: (s: S) => s.phase === 4,
    result: (s: S) => (s.phase === 4 ? { winner: 0 as const, score: [1, 0] as [number, number], reason: 'auto' } : null),
    observe: (s: S) => s,
    hash: (s: S) => hashState(s),
    encodeAction: (a: number) => a,
    decodeAction: (n: number) => n,
  } as unknown as ReturnType<typeof createCounterGame>

  const record = (): MatchRecordV1 => {
    let s = (auto as any).init(1)
    s = (auto as any).step(s, [1, null])
    s = (auto as any).step(s, [null, null])
    s = (auto as any).step(s, [null, 1])
    s = (auto as any).step(s, [null, null])
    return {
      schema: 1, matchId: 'm', game: 'four', coreVersion: 'auto-1',
      agent: { version: 'v1', level: 'easy' }, seed: 1, humanSeat: 0,
      actions: [[0, 0, 1], [2, 1, 1]],
      result: (auto as any).result(s), finalHash: (auto as any).hash(s),
      startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:01:00.000Z',
      device: 'desktop', input: 'mouse', trainingAllowed: true,
    }
  }

  test('automatic steps in the middle and at the end replay ok', () => {
    const out = replay(record(), { core: auto })
    expect(out.error).toBeUndefined()
    expect(out.ok).toBe(true)
  })

  test('a record cut before an actor step is still rejected as truncated', () => {
    const r = record()
    r.actions = [[0, 0, 1]]
    const out = replay(r, { core: auto })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ends before/)
  })
})
