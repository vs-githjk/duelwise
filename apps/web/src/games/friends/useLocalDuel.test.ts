import { describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { penaltyCore } from '@duelwise/core/src/games/penalty/core'
import { facing, localView, moverOf, normalizeNames, pickerOf, playAs, playLocal, rematchLocal, resignLocal, seatOfPlayer, startLocalDuel, tallyOf, PLAYER_ONE, PLAYER_TWO, type Entropy } from './useLocalDuel'

// The recorder and the server calls a rated match uses. A local duel must never touch them.
const calls: string[] = []
const spy = (name: string) => () => {
  calls.push(name)
  return Promise.reject(new Error(`${name} must not be called by a friend game`))
}
mock.module('../../lib/match-recorder', () => ({ useMatchRecorder: spy('useMatchRecorder'), detectDevice: () => 'desktop' }))
mock.module('../../lib/open-match', () => ({ openMatch: spy('openMatch') }))

function entropy(seeds: number[], coins: Array<0 | 1> = []): Entropy {
  let s = 0
  let c = 0
  return { seed: () => seeds[s++ % seeds.length]!, coin: () => coins[c++ % Math.max(1, coins.length)] ?? 0 }
}

const code = (core: typeof chessCore, uci: string) => core.encodeAction(uci)
const setup = { names: ['Alex', 'Sam'] as [string, string], side: 0 as const, flip: false }

function foolsMate(d: ReturnType<typeof startLocalDuel<any>>) {
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) expect(playLocal(d, code(chessCore, m)).ok).toBe(true)
}

describe('a local duel', () => {
  test('plays a whole chess game and a whole Four game without any rated-match path', () => {
    const chess = startLocalDuel(chessCore, setup, entropy([7]))
    foolsMate(chess)
    expect(chess.room.status).toBe('over')
    expect(localView(chess).result).toMatchObject({ winner: 1, reason: 'checkmate' })

    const four = startLocalDuel(fourCore, setup, entropy([9]))
    // Seat 0 stacks column 0, seat 1 stacks column 1: seat 0 gets four first.
    for (const col of [0, 1, 0, 1, 0, 1, 0]) expect(playLocal(four, fourCore.encodeAction(col)).ok).toBe(true)
    expect(four.room.status).toBe('over')
    expect(localView(four).result).toMatchObject({ winner: 0, reason: 'four in a row' })
    expect(calls).toEqual([])
  })

  test('imports no recorder, server function, storage or fetch anywhere in the friends folder', () => {
    const dir = new URL('.', import.meta.url).pathname
    const forbidden = /match-recorder|open-match|\/server\/|localStorage|sessionStorage|fetch\(|navigator\.sendBeacon/
    for (const f of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(f) || f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue
      // The two-device files (links, sockets, seat tokens in local storage) are the one place a friend game talks to anything: the relay, never a match recorder. friend-record (the signed result handed to the site) and FriendsList read and write only the head-to-head result row.
      if (/^(Challenge|session|ShareRoom|QrCode|Remote\w*|remote-logic|useRemoteDuel|friend-record|FriendsList)\./.test(f)) continue
      const src = readFileSync(dir + f, 'utf8')
      // FriendSetup may read the device's display name once, to prefill a field; that is a read of a name, never a write of a match.
      // It also names the games a link can carry (a constants file next to the token code), and shows Send a link only when the relay is set.
      const body = f === 'FriendSetup.tsx' ? src.replace(/localStorage\.getItem\(NAME_STORAGE_KEY\)/g, '').replace(/from '\.\.\/\.\.\/server\/duel-token'/, '') : src
      expect(forbidden.test(body), f).toBe(false)
    }
  })

  test('the board faces the side to move only when the setting says so', () => {
    const off = startLocalDuel(chessCore, { ...setup, flip: false }, entropy([1]))
    const on = startLocalDuel(chessCore, { ...setup, flip: true }, entropy([1]))
    expect([facing(off), facing(on)]).toEqual([0, 0])
    playLocal(off, code(chessCore, 'e2e4'))
    playLocal(on, code(chessCore, 'e2e4'))
    expect(moverOf(on)).toBe(1)
    expect(facing(off)).toBe(0)
    expect(facing(on)).toBe(1)
  })

  test('rematch swaps colours, deals a new seed and keeps the score by person', () => {
    const d = startLocalDuel(chessCore, setup, entropy([7, 8]))
    expect(seatOfPlayer(d, PLAYER_ONE)).toBe(0)
    foolsMate(d) // seat 1 (Sam) wins
    expect(tallyOf(d)).toEqual({ one: 0, two: 1, draws: 0 })
    expect(rematchLocal(d, entropy([8]))).toBe(true)
    expect(d.room.status).toBe('playing')
    expect(d.room.seed).toBe(8)
    expect(seatOfPlayer(d, PLAYER_ONE)).toBe(1)
    expect(d.room.seats[0]?.name).toBe('Sam')
    expect(chessCore.hash(d.room.state)).toBe(chessCore.hash(chessCore.init(8)))
    // Alex is Black now and resigns when it is Black's turn after one move.
    playLocal(d, code(chessCore, 'e2e4'))
    resignLocal(d)
    expect(tallyOf(d)).toEqual({ one: 0, two: 2, draws: 0 })
  })

  test('refuses an illegal move and a double submit, and the side to move is the only one that can act', () => {
    const d = startLocalDuel(chessCore, setup, entropy([3]))
    expect(playLocal(d, code(chessCore, 'e7e5'))).toEqual({ ok: false, error: 'illegal' })
    expect(playLocal(d, code(chessCore, 'e2e4')).ok).toBe(true)
    expect(localView(d, 0).legal).toEqual([])
    expect(localView(d, 1).legal.length).toBeGreaterThan(0)
  })

  test('a coin flip picks player one\'s seat, and equal or blank names are made distinct', () => {
    expect(seatOfPlayer(startLocalDuel(fourCore, { ...setup, side: 'random' }, entropy([1], [1])), PLAYER_ONE)).toBe(1)
    expect(seatOfPlayer(startLocalDuel(fourCore, { ...setup, side: 'random' }, entropy([1], [0])), PLAYER_ONE)).toBe(0)
    expect(normalizeNames(['  ', 'Sam'])).toEqual(['Player 1', 'Sam'])
    expect(normalizeNames(['Sam', ' sam '])).toEqual(['Sam', 'sam 2'])
    expect(normalizeNames(['a'.repeat(40), 'b'])[0]).toHaveLength(24)
  })

  test('the other seat never gets a view of a finished game with the wrong result', () => {
    const d = startLocalDuel(fourCore, setup, entropy([5]))
    for (const col of [0, 1, 0, 1, 0, 1, 0]) playLocal(d, fourCore.encodeAction(col))
    expect(localView(d, 0).result).toEqual(localView(d, 1).result)
  })
})

describe('simultaneous games on one device (M3)', () => {
  const dup = { ...setup }

  test('the picker is the seat the room waits for: seat 0, then seat 1, then seat 0 for the next kick', () => {
    const d = startLocalDuel(penaltyCore, dup, entropy([11]))
    expect(pickerOf(d)).toBe(0)
    expect(playAs(d, 0, 4).ok).toBe(true)
    expect(pickerOf(d)).toBe(1)
    expect(playAs(d, 1, 2).ok).toBe(true)
    expect(d.room.n).toBe(1)
    expect(pickerOf(d)).toBe(0)
  })

  test('a seat cannot pick twice in one step, and a refused pick changes nothing', () => {
    const d = startLocalDuel(penaltyCore, dup, entropy([11]))
    expect(playAs(d, 0, 4).ok).toBe(true)
    expect(playAs(d, 0, 5)).toEqual({ ok: false, error: 'not-your-turn' })
    // Seat 1 is the keeper in kick 1: a zone above 4 is not a dive.
    expect(playAs(d, 1, 7)).toEqual({ ok: false, error: 'illegal' })
    expect(d.room.log).toEqual([[0, 0, 4]])
  })

  test('the second seat sees only that the first has picked, never what it picked', () => {
    const d = startLocalDuel(penaltyCore, dup, entropy([11]))
    playAs(d, 0, 6)
    const v = localView(d, 1)
    expect(v.opponentReady).toBe(true)
    expect(JSON.stringify(v)).not.toContain('"zone":6')
    expect(v.obs).toEqual(penaltyCore.observe(d.room.state, 1))
    expect((v.obs as { kicks: unknown[] }).kicks).toEqual([])
  })

  test('nobody is the picker once the game is over', () => {
    const d = startLocalDuel(penaltyCore, dup, entropy([11]))
    resignLocal(d)
    expect(pickerOf(d)).toBeNull()
  })
})
