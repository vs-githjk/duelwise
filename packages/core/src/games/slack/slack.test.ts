import { describe, expect, test } from 'bun:test'
import { CELLS, PASS, flipsFor, slackCore, createSlackCore, type SlackState } from './index'
import { makeRng } from '../../rng'

const at = (r: number, c: number) => r * 8 + c

/** A state from rows of '.', 'x' (seat 0, value 1) and 'o' (seat 1, value 2). */
function board(rows: string[], turn: 0 | 1 = 0): SlackState {
  const cells = rows.join('').split('').map((ch) => (ch === 'x' ? 1 : ch === 'o' ? 2 : 0))
  if (cells.length !== CELLS) throw new Error('bad board')
  return { cells, turn }
}

function act(s: SlackState, a: number): SlackState {
  const x: [number | null, number | null] = [null, null]
  x[s.turn] = a
  return slackCore.step(s, x)
}

const EMPTY = '........'
const count = (s: SlackState, v: number) => s.cells.filter((c) => c === v).length

describe('slackwater core', () => {
  test('starts with four centre discs, seat 0 to act and 4 legal moves', () => {
    const s = slackCore.init(0)
    expect(s.cells[at(3, 3)]).toBe(2)
    expect(s.cells[at(4, 4)]).toBe(2)
    expect(s.cells[at(3, 4)]).toBe(1)
    expect(s.cells[at(4, 3)]).toBe(1)
    expect(count(s, 0)).toBe(60)
    expect(slackCore.toAct(s)).toEqual([0])
    expect(slackCore.legal(s, 0)).toEqual([at(2, 3), at(3, 2), at(4, 5), at(5, 4)])
    expect(slackCore.legal(s, 1)).toEqual([])
    expect(slackCore.terminal(s)).toBe(false)
    expect(slackCore.result(s)).toBeNull()
  })

  test('init ignores the seed', () => {
    expect(slackCore.init(1)).toEqual(slackCore.init(999))
    expect(slackCore.hash(slackCore.init(1))).toBe(slackCore.hash(slackCore.init(2)))
  })

  test('flips in each of the 8 directions', () => {
    // Seat 0 plays the centre cell (3,3); a line of one 'o' then an 'x' lies in each direction.
    const dirs: [number, number][] = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
    for (const [dr, dc] of dirs) {
      const cells = new Array<number>(64).fill(0)
      cells[at(3 + dr, 3 + dc)] = 2
      cells[at(3 + 2 * dr, 3 + 2 * dc)] = 1
      expect(flipsFor(cells, 1, at(3, 3)), `dir ${dr},${dc}`).toEqual([at(3 + dr, 3 + dc)])
      const s: SlackState = { cells, turn: 0 }
      const n = act(s, at(3, 3))
      expect(n.cells[at(3 + dr, 3 + dc)]).toBe(1)
      expect(n.cells[at(3, 3)]).toBe(1)
    }
  })

  test('no wrap across a row edge', () => {
    // East from (2,7) would wrap to (3,0) if rows were not bounded: a seat 1 disc there, closed by a seat 0 disc at (3,1).
    const cells = new Array<number>(64).fill(0)
    cells[at(3, 0)] = 2
    cells[at(3, 1)] = 1
    expect(flipsFor(cells, 1, at(2, 7))).toEqual([])
    // Up-left from (2,0) would wrap to (1,7)... seat 1 at (1,0) and seat 0 at (0,7) must not close a line from (2,0).
    const c2 = new Array<number>(64).fill(0)
    c2[at(0, 7)] = 1
    c2[at(1, 0)] = 2
    expect(flipsFor(c2, 1, at(2, 0))).toEqual([])
    // plain horizontal run that would only be closed by a wrapped disc is not a flip
    const c3 = new Array<number>(64).fill(0)
    c3[at(4, 6)] = 2
    c3[at(4, 7)] = 2
    c3[at(5, 0)] = 1
    expect(flipsFor(c3, 1, at(4, 5))).toEqual([])
  })

  test('a move can flip several lines at once', () => {
    const s = board([EMPTY, EMPTY, '..x.x.x.', '...ooo..', '..xo.ox.', EMPTY, EMPTY, EMPTY])
    // Seat 0 plays (4,4): north (3,4) o then (2,4) x; north-west (3,3) o then (2,2) x; north-east (3,5) o then (2,6) x;
    // west (4,3) o then (4,2) x; east (4,5) o then (4,6) x.
    const flips = flipsFor(s.cells, 1, at(4, 4)).sort((a, b) => a - b)
    expect(flips).toEqual([at(3, 3), at(3, 4), at(3, 5), at(4, 3), at(4, 5)].sort((a, b) => a - b))
    const n = act(s, at(4, 4))
    expect(count(n, 1)).toBe(count(s, 1) + 1 + 5)
    expect(count(n, 2)).toBe(count(s, 2) - 5)
    expect(n.turn).toBe(1)
  })

  test('flipsFor is empty on an occupied cell', () => {
    const s = slackCore.init(0)
    expect(flipsFor(s.cells, 1, at(3, 3))).toEqual([])
  })

  test('a pass is the only legal action when a seat has none, and is illegal otherwise', () => {
    // Seat 1 (o) to move: its only line closes against the board edge, so it has no move; seat 0 (x) still does.
    const s = board(['xo......', EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY], 1)
    expect(slackCore.legal(s, 1)).toEqual([PASS])
    expect(slackCore.terminal(s)).toBe(false)
    const n = act(s, PASS)
    expect(n.cells).toEqual(s.cells)
    expect(n.turn).toBe(0)
    expect(slackCore.legal(n, 0)).toEqual([at(0, 2)])
    // pass is illegal when a move exists
    const start = slackCore.init(0)
    expect(slackCore.legal(start, 0)).not.toContain(PASS)
    expect(() => act(start, PASS)).toThrow()
  })

  test('the game ends at once when neither seat can move', () => {
    const s = board(['xxxxxxxx', 'xxxxxxxx', 'xxxxxxxx', 'xxxxxxxx', 'xxxxxxxx', 'xxxxxxxx', 'xxxxxxxx', 'xxxxxxx.'], 1)
    expect(slackCore.terminal(s)).toBe(true)
    expect(slackCore.toAct(s)).toEqual([])
    expect(slackCore.legal(s, 0)).toEqual([])
    expect(slackCore.legal(s, 1)).toEqual([])
    expect(() => act(s, PASS)).toThrow()
  })

  test('ending move: the game is over right after the last flip when the other seat is stuck', () => {
    // x plays (0,2) flipping (0,1); afterwards o has no discs, so neither seat can move.
    const s = board(['xo......', EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY], 0)
    expect(slackCore.legal(s, 0)).toEqual([at(0, 2)])
    const n = act(s, at(0, 2))
    expect(slackCore.terminal(n)).toBe(true)
    expect(slackCore.result(n)).toEqual({ winner: 0, score: [1, 0], reason: 'most discs' })
  })

  test('win, loss, and level results with reasons', () => {
    const full = (xCount: number): SlackState => {
      const cells = new Array<number>(64).fill(2)
      for (let i = 0; i < xCount; i++) cells[i] = 1
      return { cells, turn: 0 }
    }
    expect(slackCore.terminal(full(40))).toBe(true)
    expect(slackCore.result(full(40))).toEqual({ winner: 0, score: [1, 0], reason: 'most discs' })
    expect(slackCore.result(full(10))).toEqual({ winner: 1, score: [0, 1], reason: 'most discs' })
    expect(slackCore.result(full(32))).toEqual({ winner: null, score: [0.5, 0.5], reason: 'level on discs' })
  })

  test('empties are not awarded: a win with empty cells left counts discs only', () => {
    const s = board(['xxxxxxxx', EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY], 0)
    expect(slackCore.terminal(s)).toBe(true)
    expect(slackCore.result(s)).toEqual({ winner: 0, score: [1, 0], reason: 'most discs' })
  })

  test('a wipe-out ends the game for the seat that still has discs', () => {
    const s = board(['.ox.....', EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY], 1)
    // o at (0,1), x at (0,2): o plays (0,3) flipping (0,2), and x has no discs left.
    const n = act(s, at(0, 3))
    expect(count(n, 1)).toBe(0)
    expect(slackCore.terminal(n)).toBe(true)
    expect(slackCore.result(n)).toEqual({ winner: 1, score: [0, 1], reason: 'most discs' })
  })

  test('observe flips colours to mine and theirs and lists legal moves', () => {
    const s = slackCore.init(0)
    const o0 = slackCore.observe(s, 0)
    expect(o0.seat).toBe(0)
    expect(o0.toMove).toBe(true)
    expect(o0.legal).toEqual(slackCore.legal(s, 0))
    expect(o0.discs).toEqual([2, 2])
    expect(o0.cells[at(3, 4)]).toBe(1)
    expect(o0.cells[at(3, 3)]).toBe(2)
    const o1 = slackCore.observe(s, 1)
    expect(o1.toMove).toBe(false)
    expect(o1.legal).toEqual([])
    expect(o1.cells[at(3, 4)]).toBe(2)
    expect(o1.cells[at(3, 3)]).toBe(1)
  })

  test('every code 0..64 round-trips and 65 throws', () => {
    for (let n = 0; n <= 64; n++) {
      const a = slackCore.decodeAction(n)
      expect(slackCore.encodeAction(a)).toBe(n)
    }
    expect(() => slackCore.decodeAction(65)).toThrow()
    expect(() => slackCore.decodeAction(-1)).toThrow()
    expect(() => slackCore.decodeAction(1.5)).toThrow()
    expect(() => slackCore.encodeAction(65)).toThrow()
    expect(() => slackCore.encodeAction(-1)).toThrow()
  })

  test('step is pure and rejects a wrong seat, a missing action and an illegal cell', () => {
    const s = slackCore.init(0)
    const before = JSON.stringify(s)
    const n = act(s, at(2, 3))
    expect(JSON.stringify(s)).toBe(before)
    expect(n).not.toBe(s)
    expect(() => slackCore.step(s, [null, null])).toThrow()
    expect(() => slackCore.step(s, [null, at(2, 3)])).toThrow()
    expect(() => slackCore.step(s, [at(2, 3), at(2, 3)])).toThrow()
    expect(() => act(s, at(0, 0))).toThrow()
    expect(() => act(s, at(3, 3))).toThrow()
    expect(() => act(s, 70)).toThrow()
  })

  test('same actions give the same hash, different states differ', () => {
    const run = (cells: number[]) => cells.reduce((s, a) => act(s, a), slackCore.init(0))
    const a = run([at(2, 3), at(2, 2)])
    const b = run([at(2, 3), at(2, 2)])
    expect(slackCore.hash(a)).toBe(slackCore.hash(b))
    expect(slackCore.hash(a)).toMatch(/^[0-9a-f]{16}$/)
    expect(slackCore.hash(a)).not.toBe(slackCore.hash(slackCore.init(0)))
    // same discs, other seat to move, is another state
    expect(slackCore.hash({ ...a, turn: 0 })).not.toBe(slackCore.hash({ ...a, turn: 1 }))
  })

  test('createSlackCore returns the core', () => {
    expect(createSlackCore()).toBe(slackCore)
    expect(slackCore.version).toBe('slack-1')
  })

  test('a full random match steps through legal, encodeAction and decodeAction', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = makeRng(seed)
      let s = slackCore.init(seed)
      let plies = 0
      while (!slackCore.terminal(s)) {
        const [seat] = slackCore.toAct(s)
        expect(slackCore.toAct(s).length).toBe(1)
        const moves = slackCore.legal(s, seat!)
        expect(moves.length).toBeGreaterThan(0)
        const pick = moves[rng.int(moves.length)]!
        const back = slackCore.decodeAction(slackCore.encodeAction(pick))
        expect(back).toBe(pick)
        const x: [number | null, number | null] = [null, null]
        x[seat!] = back
        s = slackCore.step(s, x)
        plies++
        expect(plies).toBeLessThan(200)
      }
      const r = slackCore.result(s)!
      const [d0, d1] = [count(s, 1), count(s, 2)]
      expect(r.winner).toBe(d0 > d1 ? 0 : d1 > d0 ? 1 : null)
      expect(r.reason).toBe(d0 === d1 ? 'level on discs' : 'most discs')
      // neither seat has a move at the end
      expect(slackCore.legal({ cells: s.cells, turn: 0 }, 0).length + slackCore.legal({ cells: s.cells, turn: 1 }, 1).length).toBe(0)
    }
  })
})
