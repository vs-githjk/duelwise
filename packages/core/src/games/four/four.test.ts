import { describe, expect, test } from 'bun:test'
import { fourCore, fourEncoder, fourFromMoves, type FourState } from './index'
import { getCore } from '../index'
import { makeRng } from '../../rng'

/** Plays columns in order (seat 0 first) and returns the final state. */
function play(cols: number[]): FourState {
  let s = fourCore.init(1)
  for (const c of cols) {
    const seat = s.n % 2 === 0 ? 0 : 1
    const a: [number | null, number | null] = [null, null]
    a[seat] = c
    s = fourCore.step(s, a)
  }
  return s
}

describe('four in a row core', () => {
  test('registry exposes the real core', () => {
    expect(getCore('four')).toBe(fourCore)
    expect(fourCore.id).toBe('four')
  })

  test('starts empty with seat 0 to act and 7 legal columns', () => {
    const s = fourCore.init(0)
    expect(fourCore.toAct(s)).toEqual([0])
    expect(fourCore.legal(s, 0)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(fourCore.legal(s, 1)).toEqual([])
    expect(fourCore.terminal(s)).toBe(false)
    expect(fourCore.result(s)).toBeNull()
  })

  test('horizontal win', () => {
    const s = play([0, 0, 1, 1, 2, 2, 3])
    expect(fourCore.terminal(s)).toBe(true)
    expect(fourCore.result(s)).toEqual({ winner: 0, score: [1, 0], reason: 'four in a row' })
    expect(fourCore.toAct(s)).toEqual([])
    expect(fourCore.legal(s, 1)).toEqual([])
  })

  test('vertical win by seat 1', () => {
    const s = play([0, 1, 0, 1, 0, 1, 2, 1])
    expect(fourCore.result(s)).toEqual({ winner: 1, score: [0, 1], reason: 'four in a row' })
  })

  test('diagonal win rising to the right', () => {
    // seat 0 stones at (0,0) (1,1) (2,2) (3,3)
    const s = play([0, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3])
    expect(fourCore.result(s)?.winner).toBe(0)
    expect(s.n).toBe(11)
  })

  test('diagonal win falling to the right', () => {
    // mirror of the rising case: seat 0 at (6,0) (5,1) (4,2) (3,3)
    const s = play([6, 5, 5, 4, 3, 4, 4, 3, 2, 3, 3])
    expect(fourCore.result(s)?.winner).toBe(0)
  })

  test('four across a column boundary does not wrap', () => {
    // seat 0 stones at row 0 of columns 5, 6 and row 0.. of 0, 1: no win by wrap-around
    const s = play([5, 4, 6, 4, 0, 4, 1])
    expect(fourCore.terminal(s)).toBe(false)
  })

  test('a full board with no four is a draw', () => {
    let drawn: FourState | null = null
    for (let seed = 1; seed < 400 && drawn === null; seed++) {
      const rng = makeRng(seed)
      let s = fourCore.init(seed)
      while (!fourCore.terminal(s)) {
        const seat = s.n % 2 === 0 ? 0 : 1
        const safe = fourCore.legal(s, seat as 0 | 1).filter((c) => {
          const a: [number | null, number | null] = [null, null]
          a[seat] = c
          return fourCore.result(fourCore.step(s, a))?.winner == null
        })
        if (safe.length === 0) break
        const c = safe[rng.int(safe.length)]!
        const a: [number | null, number | null] = [null, null]
        a[seat] = c
        s = fourCore.step(s, a)
      }
      if (s.n === 42 && fourCore.terminal(s)) drawn = s
    }
    expect(drawn).not.toBeNull()
    expect(fourCore.result(drawn!)).toEqual({ winner: null, score: [0.5, 0.5], reason: 'board full' })
    expect(fourCore.legal(drawn!, 0)).toEqual([])
  })

  test('illegal columns are rejected', () => {
    const s = fourCore.init(0)
    expect(() => fourCore.step(s, [7, null])).toThrow(/illegal/)
    expect(() => fourCore.step(s, [-1, null])).toThrow(/illegal/)
    expect(() => fourCore.step(s, [1.5, null])).toThrow(/illegal/)
    expect(() => fourCore.step(s, [null, 3])).toThrow()
    expect(() => fourCore.step(s, [null, null])).toThrow()
    // full column: 6 stones in column 0 without a win (alternating seats), 7th is rejected
    const full = play([0, 0, 0, 0, 0, 0].slice(0, 6))
    expect(fourCore.legal(full, 0)).toEqual([1, 2, 3, 4, 5, 6])
    expect(() => fourCore.step(full, [0, null])).toThrow(/illegal/)
    // stepping a finished game is rejected
    const won = play([0, 0, 1, 1, 2, 2, 3])
    expect(() => fourCore.step(won, [null, 4])).toThrow()
    expect(() => fourCore.step(won, [4, null])).toThrow()
  })

  test('step is pure and hash tracks the position', () => {
    const s = fourCore.init(0)
    const t = fourCore.step(s, [3, null])
    expect(s.n).toBe(0)
    expect(t.n).toBe(1)
    expect(fourCore.hash(s)).not.toBe(fourCore.hash(t))
    expect(fourCore.hash(t)).toMatch(/^[0-9a-f]{16}$/)
    expect(fourCore.hash(play([3, 2, 4]))).toBe(fourCore.hash(fourFromMoves([3, 2, 4])))
    // same stones reached by different orders of different colours differ
    expect(fourCore.hash(play([3, 2]))).not.toBe(fourCore.hash(play([2, 3])))
  })

  test('action codec is the column', () => {
    for (let c = 0; c < 7; c++) expect(fourCore.decodeAction(fourCore.encodeAction(c))).toBe(c)
    expect(() => fourCore.decodeAction(7)).toThrow()
  })

  test('observe hides nothing and is relative to the observer', () => {
    const s = play([3, 4])
    const o0 = fourCore.observe(s, 0)
    const o1 = fourCore.observe(s, 1)
    expect(o0.cells[3]).toBe(1)
    expect(o0.cells[4]).toBe(2)
    expect(o1.cells[3]).toBe(2)
    expect(o1.cells[4]).toBe(1)
    expect(o0.toMove).toBe(true)
    expect(o1.toMove).toBe(false)
  })

  test('encoder writes 3 planes of 6x7 at the offset', () => {
    expect(fourEncoder.shape).toEqual([3, 6, 7])
    const s = play([3, 4])
    const out = new Float32Array(130)
    fourEncoder.encode(fourCore.observe(s, 0), out, 4)
    expect(out[4 + 3]).toBe(1) // my stone at row 0 col 3
    expect(out[4 + 42 + 4]).toBe(1) // opponent stone
    expect(out[4 + 84]).toBe(1) // my turn plane
    expect(out[0]).toBe(0)
    let sum = 0
    for (let i = 0; i < 126; i++) sum += out[4 + i]!
    expect(sum).toBe(2 + 42)
    const out1 = new Float32Array(126)
    fourEncoder.encode(fourCore.observe(s, 1), out1, 0)
    expect(out1[3 + 42]).toBe(1)
    expect(out1[4]).toBe(1)
    expect(out1[84]).toBe(0)
  })

  test('random playouts are deterministic and always end', () => {
    const run = (seed: number): string => {
      const rng = makeRng(seed)
      let s = fourCore.init(seed)
      while (!fourCore.terminal(s)) {
        const seat = s.n % 2 === 0 ? 0 : 1
        const l = fourCore.legal(s, seat as 0 | 1)
        const a: [number | null, number | null] = [null, null]
        a[seat] = l[rng.int(l.length)]!
        s = fourCore.step(s, a)
      }
      return fourCore.hash(s)
    }
    for (let seed = 1; seed <= 50; seed++) expect(run(seed)).toBe(run(seed))
  })
})
