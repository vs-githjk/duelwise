import { describe, expect, test } from 'bun:test'
import { PRODUCT } from '../../product'
import { getCore } from '../index'
import { makeRng } from '../../rng'
import { cairnCore, optimalTake, MAX_PILE, MIN_PILE, type CairnState } from './index'

function take(s: CairnState, n: number): CairnState {
  return cairnCore.step(s, s.turn === 0 ? [n, null] : [null, n])
}

describe('cairn core (the template game)', () => {
  test('init: the seed picks a pile size from 13 to 24, seat 0 to act, same seed same pile', () => {
    const piles = new Set<number>()
    for (let seed = 0; seed < 200; seed++) {
      const s = cairnCore.init(seed)
      expect(s.pile).toBeGreaterThanOrEqual(MIN_PILE)
      expect(s.pile).toBeLessThanOrEqual(MAX_PILE)
      expect(s).toEqual(cairnCore.init(seed))
      expect(cairnCore.toAct(s)).toEqual([0])
      piles.add(s.pile)
    }
    expect(piles.size).toBe(MAX_PILE - MIN_PILE + 1)
  })

  test('legal moves are 1 to 3, only for the seat to act, and never more than the pile', () => {
    const s: CairnState = { pile: 2, turn: 1, winner: null }
    expect(cairnCore.legal(s, 1)).toEqual([1, 2])
    expect(cairnCore.legal(s, 0)).toEqual([])
    expect(cairnCore.legal({ pile: 20, turn: 0, winner: null }, 0)).toEqual([1, 2, 3])
  })

  test('taking the last stone wins and ends the game', () => {
    let s: CairnState = { pile: 3, turn: 0, winner: null }
    s = take(s, 2)
    expect(s).toEqual({ pile: 1, turn: 1, winner: null })
    s = take(s, 1)
    expect(cairnCore.terminal(s)).toBe(true)
    expect(cairnCore.result(s)).toEqual({ winner: 1, score: [0, 1], reason: 'took the last stone' })
    expect(cairnCore.toAct(s)).toEqual([])
    expect(cairnCore.legal(s, 1)).toEqual([])
    expect(() => take(s, 1)).toThrow('the game is over')
  })

  test('step rejects illegal, missing and wrong-seat actions', () => {
    const s: CairnState = { pile: 5, turn: 0, winner: null }
    expect(() => cairnCore.step(s, [4, null])).toThrow('illegal take')
    expect(() => cairnCore.step(s, [0, null])).toThrow('illegal take')
    expect(() => cairnCore.step({ pile: 2, turn: 0, winner: null }, [3, null])).toThrow('illegal take')
    expect(() => cairnCore.step(s, [null, null])).toThrow('missing action')
    expect(() => cairnCore.step(s, [1, 1])).toThrow('only seat 0 may act')
  })

  test('observe shows the pile and whose move it is; there is no hidden information', () => {
    const s: CairnState = { pile: 9, turn: 1, winner: null }
    expect(cairnCore.observe(s, 0)).toEqual({ pile: 9, seat: 0, toMove: false })
    expect(cairnCore.observe(s, 1)).toEqual({ pile: 9, seat: 1, toMove: true })
  })

  test('encode and decode round-trip and reject bad codes', () => {
    for (const n of [1, 2, 3]) expect(cairnCore.decodeAction(cairnCore.encodeAction(n))).toBe(n)
    expect(() => cairnCore.encodeAction(0)).toThrow()
    expect(() => cairnCore.decodeAction(4)).toThrow()
    expect(() => cairnCore.decodeAction(1.5)).toThrow()
  })

  test('replaying the same seed and actions gives the same hash, different piles give different hashes', () => {
    const run = (seed: number) => {
      const rng = makeRng(seed ^ 77)
      let s = cairnCore.init(seed)
      while (!cairnCore.terminal(s)) {
        const legal = cairnCore.legal(s, s.turn)
        s = take(s, legal[rng.int(legal.length)]!)
      }
      return cairnCore.hash(s)
    }
    expect(run(5)).toBe(run(5))
    expect(cairnCore.hash({ pile: 5, turn: 0, winner: null })).not.toBe(cairnCore.hash({ pile: 6, turn: 0, winner: null }))
    expect(cairnCore.hash(cairnCore.init(1))).toMatch(/^[0-9a-f]{16}$/)
  })

  test('optimalTake leaves a multiple of four when it can', () => {
    for (let pile = 1; pile <= MAX_PILE; pile++) {
      const t = optimalTake(pile)
      expect(t).toBeGreaterThanOrEqual(1)
      expect(t).toBeLessThanOrEqual(Math.min(3, pile))
      if (pile % 4 !== 0) expect((pile - t) % 4).toBe(0)
    }
  })

  test('the template is not a product game: no PRODUCT entry, no getCore entry', () => {
    expect(Object.keys(PRODUCT.games)).not.toContain('cairn')
    expect(() => getCore('cairn' as never)).toThrow()
  })
})
