import type { GameCore, Result, Seat } from '../types'
import type { GameId } from '../product'
import { hashState } from '../hash'
import { makeRng } from '../rng'

// Toy games used only by tests: they exercise replay, records and agent stubs
// without any real game. Not exported from the package index.

export interface CounterState {
  total: number
  target: number
  turn: Seat
  winner: Seat | null
}

/** Turn-based: players alternate adding 1 to 3; whoever reaches the seeded target wins. */
export function createCounterGame(id: GameId = 'four'): GameCore<CounterState, number, { total: number; target: number }> {
  return {
    id,
    version: 'counter-1',
    init(seed) {
      return { total: 0, target: 8 + makeRng(seed).int(8), turn: 0, winner: null }
    },
    toAct: (s) => (s.winner === null ? [s.turn] : []),
    legal: (s, seat) => (s.winner === null && seat === s.turn ? [1, 2, 3] : []),
    step(s, actions) {
      const a = actions[s.turn]
      if (a === null || a === undefined) throw new Error('counter: missing action')
      if (a < 1 || a > 3) throw new Error('counter: illegal action ' + a)
      const total = s.total + a
      return total >= s.target
        ? { ...s, total, winner: s.turn }
        : { ...s, total, turn: (1 - s.turn) as Seat }
    },
    terminal: (s) => s.winner !== null,
    result(s): Result | null {
      if (s.winner === null) return null
      return { winner: s.winner, score: s.winner === 0 ? [1, 0] : [0, 1], reason: 'reached target' }
    },
    observe: (s) => ({ total: s.total, target: s.target }),
    hash: (s) => hashState(s),
    encodeAction: (a) => a,
    decodeAction: (n) => n,
  }
}

export interface DriftState {
  pos: [number, number]
  frame: number
}

/** Realtime: both seats act every frame with 0 (left), 1 (stay) or 2 (right). First to reach +-5 wins. */
export function createDriftGame(id: GameId = 'fighter'): GameCore<DriftState, number, { pos: [number, number]; frame: number }> {
  const maxFrames = 200
  return {
    id,
    version: 'drift-1',
    init: () => ({ pos: [0, 0], frame: 0 }),
    toAct: (s) => (s.frame < maxFrames ? [0, 1] : []),
    legal: () => [],
    step(s, actions) {
      const d = (a: number | null) => (a === null ? 0 : a - 1)
      return { pos: [s.pos[0] + d(actions[0]), s.pos[1] + d(actions[1])], frame: s.frame + 1 }
    },
    terminal: (s) => Math.abs(s.pos[0]) >= 5 || Math.abs(s.pos[1]) >= 5 || s.frame >= maxFrames,
    result(s): Result | null {
      if (!(Math.abs(s.pos[0]) >= 5 || Math.abs(s.pos[1]) >= 5 || s.frame >= maxFrames)) return null
      const a = Math.abs(s.pos[0])
      const b = Math.abs(s.pos[1])
      return { winner: a === b ? null : a > b ? 0 : 1, score: [a, b], reason: 'drift' }
    },
    observe: (s) => ({ pos: [...s.pos] as [number, number], frame: s.frame }),
    hash: (s) => hashState(s),
    encodeAction: (a) => a,
    decodeAction: (n) => n,
  }
}
