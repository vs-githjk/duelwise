import { describe, expect, test } from 'bun:test'
import { makeRng, rngFromState } from './rng'

const PINNED: Record<number, number[]> = {
  // Cross-checked against an independent Python implementation of splitmix32 and xoshiro128**.
  0: [1789933344, 44971166, 2521387044, 3848737593, 1138324114, 749234105, 1899511038, 1995189375],
  1: [393288148, 2174103013, 3814759091, 2092745082, 1865176206, 2179171167, 3207394750, 2858353069],
  42: [660444221, 3652823732, 77672526, 910233633, 2297337756, 3786072677, 3123505064, 1891482476],
}

describe('rng', () => {
  for (const seed of [0, 1, 42]) {
    test(`first 8 outputs for seed ${seed} are pinned`, () => {
      const r = makeRng(seed)
      const out = Array.from({ length: 8 }, () => r.nextU32())
      expect(out).toEqual(PINNED[seed]!)
    })
  }

  test('same seed gives the same stream, different seeds differ', () => {
    const a = makeRng(7)
    const b = makeRng(7)
    const c = makeRng(8)
    const sa = Array.from({ length: 16 }, () => a.nextU32())
    expect(Array.from({ length: 16 }, () => b.nextU32())).toEqual(sa)
    expect(Array.from({ length: 16 }, () => c.nextU32())).not.toEqual(sa)
  })

  test('state round-trips and continues the stream', () => {
    const a = makeRng(99)
    for (let i = 0; i < 5; i++) a.nextU32()
    const snap = a.state()
    expect(snap).toBeInstanceOf(Uint32Array)
    expect(snap.length).toBe(4)
    const b = rngFromState(snap)
    for (let i = 0; i < 20; i++) expect(b.nextU32()).toBe(a.nextU32())
  })

  test('state() returns a copy', () => {
    const r = makeRng(3)
    const s = r.state()
    s[0] = 12345
    expect(r.state()[0]).not.toBe(12345)
  })

  test('float is in [0, 1)', () => {
    const r = makeRng(5)
    for (let i = 0; i < 1000; i++) {
      const f = r.float()
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
    }
  })

  test('int(n) stays in range and covers every value', () => {
    const r = makeRng(11)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const v = r.int(6)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(6)
      seen.add(v)
    }
    expect(seen.size).toBe(6)
    expect(r.int(1)).toBe(0)
  })

  test('int rejects non-positive or non-integer bounds', () => {
    const r = makeRng(1)
    expect(() => r.int(0)).toThrow()
    expect(() => r.int(-3)).toThrow()
    expect(() => r.int(2.5)).toThrow()
  })

  test('rngFromState rejects bad state', () => {
    expect(() => rngFromState(new Uint32Array(3))).toThrow()
    expect(() => rngFromState(new Uint32Array(4))).toThrow()
  })
})
