import { describe, expect, test } from 'bun:test'
import { replay } from '../replay'
import type { MatchRecordV1 } from '../match-record'
import { getCore } from '../games/index'
import type { GameId } from '../product'
import { makeRng } from '../rng'
import type { Seat } from '../types'
import { createRoom, fromSnapshot, join, resign, resultOf, seatOf, setConnected, submit, toSnapshot, viewFor, voteRematch, type DuelRoom } from './room'

const ada = { ref: 'ref-ada', name: 'Ada', connected: true }
const sam = { ref: 'ref-sam', name: 'Sam', connected: true }

function start(game: GameId, seed: number, hostSeat: Seat = 0, options?: Record<string, unknown>): DuelRoom<any> {
  const room = createRoom(getCore(game), seed, ada, hostSeat, options)
  expect(join(room, sam).ok).toBe(true)
  return room
}

/** Plays every seat that can act with a random legal action until the room is over. Returns the number of submits. */
function playOut(room: DuelRoom<any>, rng: ReturnType<typeof makeRng>, cap = 5000): number {
  let submits = 0
  while (room.status === 'playing') {
    if (submits++ > cap) throw new Error('game did not end')
    let acted = false
    for (const seat of [0, 1] as const) {
      const v = viewFor(room, seat)
      if (!v.canAct) continue
      const r = submit(room, seat, v.legal[rng.int(v.legal.length)]!, v.n)
      expect(r.ok).toBe(true)
      acted = true
    }
    expect(acted).toBe(true)
  }
  return submits
}

function recordOf(room: DuelRoom<any>, humanSeat: Seat = 0): MatchRecordV1 {
  const core = getCore(room.game)
  const res = core.result(room.state)!
  return {
    schema: 1, matchId: 'room-test', game: room.game, coreVersion: core.version, agent: { version: 'v1', level: 'easy' },
    seed: room.seed, humanSeat, actions: room.log.map((e) => [e[0], e[1], e[2]] as [number, Seat, number]), result: res, finalHash: core.hash(room.state),
    startedAt: '2026-11-10T10:00:00.000Z', endedAt: '2026-11-10T10:01:00.000Z', device: 'desktop', input: 'mouse', trainingAllowed: false,
    ...(room.options ? { options: room.options } : {}),
  }
}

describe('room core: whole games replay to the same result', () => {
  for (const game of ['four', 'slack', 'chess'] as const) {
    test(`${game}: a random game through the room replays to the same result and hash`, () => {
      for (const seed of [1, 2, 3]) {
        const room = start(game, seed)
        playOut(room, makeRng(seed ^ 0xabc))
        expect(room.status).toBe('over')
        const out = replay(recordOf(room))
        expect(out.error).toBeUndefined()
        expect(out.ok).toBe(true)
        expect(viewFor(room, 0).result).toEqual(out.result)
        expect(viewFor(room, 1).result).toEqual(out.result)
      }
    })
  }
  for (const game of ['penalty', 'word', 'fleet'] as const) {
    test(`${game}: simultaneous picks and setup also replay`, () => {
      for (const seed of [4, 5]) {
        const room = start(game, seed)
        playOut(room, makeRng(seed))
        const out = replay(recordOf(room))
        expect(out.error).toBeUndefined()
        expect(out.ok).toBe(true)
      }
    })
  }
})

describe('room core: refusals', () => {
  test('waiting room, out of turn, stale n, double submit, illegal action and a bad number are refused', () => {
    const room = createRoom(getCore('four'), 7, ada, 0)
    expect(submit(room, 0, 3, 0)).toEqual({ ok: false, error: 'waiting' })
    join(room, sam)
    // seat 1 is not to act first
    expect(submit(room, 1, 3, 0)).toEqual({ ok: false, error: 'not-your-turn' })
    expect(submit(room, 0, 3, 5)).toEqual({ ok: false, error: 'stale' })
    expect(submit(room, 0, 99, 0)).toEqual({ ok: false, error: 'illegal' })
    expect(submit(room, 0, 1.5, 0)).toEqual({ ok: false, error: 'illegal' })
    expect(submit(room, 0, 3, 0)).toEqual({ ok: true })
    // the same n again is stale now; the same seat again is not its turn
    expect(submit(room, 0, 3, 0)).toEqual({ ok: false, error: 'stale' })
    expect(submit(room, 0, 4, 1)).toEqual({ ok: false, error: 'not-your-turn' })
    expect(room.log.length).toBe(1)
    expect(room.n).toBe(1)
  })

  test('a full column is illegal and chess refuses a move for the wrong side', () => {
    const four = start('four', 1)
    for (let i = 0; i < 6; i++) expect(submit(four, (i % 2) as Seat, 0, i).ok).toBe(true)
    expect(submit(four, 0, 0, 6)).toEqual({ ok: false, error: 'illegal' })
    const chess = start('chess', 1)
    const v0 = viewFor(chess, 0)
    const v1 = viewFor(chess, 1)
    expect(v0.canAct).toBe(true)
    expect(v1.canAct).toBe(false)
    expect(v1.legal).toEqual([])
    expect(submit(chess, 1, v0.legal[0]!, 0)).toEqual({ ok: false, error: 'not-your-turn' })
  })

  test('simultaneous game: a second pick from the same seat is refused and the step waits for the other seat', () => {
    const room = start('penalty', 11)
    const n = room.n
    expect(submit(room, 0, 4, n)).toEqual({ ok: true })
    expect(room.n).toBe(n)
    expect(submit(room, 0, 5, n)).toEqual({ ok: false, error: 'not-your-turn' })
    expect(viewFor(room, 0).canAct).toBe(false)
    expect(viewFor(room, 0).legal).toEqual([])
    expect(viewFor(room, 1).opponentReady).toBe(true)
    expect(viewFor(room, 0).opponentReady).toBe(false)
    // seat 1 picks, the kick resolves and the step advances
    const v1 = viewFor(room, 1)
    expect(submit(room, 1, v1.legal[0]!, n)).toEqual({ ok: true })
    expect(room.n).toBe(n + 1)
  })

  test('Word Duel resolves a round only when both seats guessed', () => {
    const room = start('word', 3)
    const g0 = viewFor(room, 0).legal[0]!
    const g1 = viewFor(room, 1).legal[1]!
    expect(submit(room, 0, g0, 0).ok).toBe(true)
    expect((viewFor(room, 0).obs as { guesses: string[] }).guesses).toEqual([])
    expect(submit(room, 1, g1, 0).ok).toBe(true)
    expect((viewFor(room, 0).obs as { guesses: string[] }).guesses.length).toBe(1)
    expect(room.n).toBe(1)
  })

  test('nothing is accepted after the game is over', () => {
    const room = start('four', 1)
    resign(room, 0)
    expect(submit(room, 1, 3, 0)).toEqual({ ok: false, error: 'over' })
  })
})

describe('room core: seats, resign, rematch', () => {
  test('join: second person starts the game, a third is refused, the same ref gets its seat back', () => {
    const room = createRoom(getCore('four'), 1, ada, 1)
    expect(room.status).toBe('waiting')
    expect(join(room, sam)).toEqual({ ok: true, seat: 0 })
    expect(room.status).toBe('playing')
    expect(join(room, { ref: 'ref-x', name: 'X', connected: true })).toEqual({ ok: false, error: 'full' })
    expect(join(room, { ...ada, name: 'Imposter' })).toEqual({ ok: true, seat: 1 })
    expect(room.seats[1]!.name).toBe('Ada')
    expect(seatOf(room, 'ref-sam')).toBe(0)
    setConnected(room, 0, false)
    expect(viewFor(room, 1).connected).toEqual([false, true])
    expect(viewFor(room, 1).names).toEqual(['Sam', 'Ada'])
  })

  test('joining a closed room is refused', () => {
    const room = createRoom(getCore('four'), 1, ada, 0)
    resign(room, 0)
    expect(join(room, sam)).toEqual({ ok: false, error: 'over' })
    expect(room.series).toEqual([])
  })

  test('resign ends it for the other seat and counts in the series', () => {
    const room = start('four', 1)
    submit(room, 0, 3, 0)
    resign(room, 1)
    expect(room.status).toBe('over')
    expect(viewFor(room, 0).result).toEqual({ winner: 0, score: [1, 0], reason: 'resigned' })
    expect(viewFor(room, 1).result).toEqual({ winner: 0, score: [1, 0], reason: 'resigned' })
    expect(viewFor(room, 0).tally).toEqual({ you: 1, them: 0, draws: 0 })
    expect(viewFor(room, 1).tally).toEqual({ you: 0, them: 1, draws: 0 })
    resign(room, 0)
    expect(room.series.length).toBe(1)
    expect(resultOf(room)!.reason).toBe('resigned')
  })

  test('rematch needs two votes, swaps sides, takes the new seed and keeps the tally', () => {
    const room = start('four', 1, 0)
    resign(room, 1)
    expect(voteRematch(room, 0, 99)).toBe(false)
    expect(room.status).toBe('over')
    expect(voteRematch(room, 0, 98)).toBe(false)
    expect(viewFor(room, 1).rematch).toEqual([true, false])
    expect(voteRematch(room, 1, 123)).toBe(true)
    expect(room.status).toBe('playing')
    expect(room.seed).toBe(123)
    expect(room.n).toBe(0)
    expect(room.log).toEqual([])
    expect(room.resigned).toBeNull()
    expect(room.rematch).toEqual([false, false])
    // Ada was seat 0, so she is seat 1 now and Sam moves first
    expect(room.seats[0]!.name).toBe('Sam')
    expect(room.seats[1]!.name).toBe('Ada')
    expect(viewFor(room, 0).canAct).toBe(true)
    expect(viewFor(room, 0).seed).toBeNull()
    expect(viewFor(room, 1).tally).toEqual({ you: 1, them: 0, draws: 0 })
    // a vote while the game is running does nothing
    expect(voteRematch(room, 0, 5)).toBe(false)
    expect(room.rematch).toEqual([false, false])
  })

  test('a game played after a rematch replays from its own seed and log', () => {
    const room = start('four', 1)
    playOut(room, makeRng(1))
    voteRematch(room, 0, 50)
    voteRematch(room, 1, 51)
    expect(room.seed).toBe(51)
    playOut(room, makeRng(2))
    expect(replay(recordOf(room)).ok).toBe(true)
    expect(room.series.length).toBe(2)
  })

  test('the seed is revealed only after the game is over', () => {
    const room = start('word', 8)
    expect(viewFor(room, 0).seed).toBeNull()
    resign(room, 0)
    expect(viewFor(room, 1).seed).toBe(8)
  })

  test('a realtime game cannot be a friend room', () => {
    expect(() => createRoom(getCore('puck'), 1, ada, 0)).toThrow('realtime')
  })
})

describe('room core: snapshot and restore (a hibernating host)', () => {
  for (const game of ['chess', 'penalty', 'fleet', 'word'] as const) {
    test(`${game}: restoring the snapshot mid-game, with a pick waiting, gives the same views and finishes the same`, () => {
      const room = start(game, 21)
      const rng = makeRng(21)
      // play about a third of the way, then leave one seat's pick waiting where the game is simultaneous
      for (let i = 0; i < 6 && room.status === 'playing'; i++) {
        const seat = [0, 1].find((s) => viewFor(room, s as Seat).canAct) as Seat
        const v = viewFor(room, seat)
        submit(room, seat, v.legal[rng.int(v.legal.length)]!, v.n)
      }
      const snap = JSON.parse(JSON.stringify(toSnapshot(room)))
      const back = fromSnapshot(getCore(game), snap)
      for (const seat of [0, 1] as const) expect(viewFor(back, seat)).toEqual(viewFor(room, seat))
      expect(back.pending).toEqual(room.pending)
      expect(back.log).toEqual(room.log)
      playOut(back, makeRng(5))
      expect(replay(recordOf(back)).ok).toBe(true)
    })
  }

  test('a snapshot with a corrupt log refuses to load', () => {
    const room = start('four', 1)
    submit(room, 0, 3, 0)
    const snap = toSnapshot(room)
    snap.log.push([1, 1, 99])
    expect(() => fromSnapshot(getCore('four'), snap)).toThrow('refused')
    const wrong = toSnapshot(room)
    expect(() => fromSnapshot(getCore('chess'), wrong)).toThrow('snapshot is for four')
  })

  test('a resigned room restores as resigned with its series', () => {
    const room = start('four', 1)
    resign(room, 0)
    const back = fromSnapshot(getCore('four'), toSnapshot(room))
    expect(back.status).toBe('over')
    expect(viewFor(back, 1).result!.reason).toBe('resigned')
    expect(back.series).toEqual(room.series)
  })
})
