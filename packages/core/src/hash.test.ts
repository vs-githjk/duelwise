import { describe, expect, test } from 'bun:test'
import { canonicalEncode, fnv1a64, hashState } from './hash'

describe('fnv1a64', () => {
  // Published FNV-1a 64 test vectors.
  test('empty string', () => expect(fnv1a64('')).toBe('cbf29ce484222325'))
  test('"a"', () => expect(fnv1a64('a')).toBe('af63dc4c8601ec8c'))
  test('"foobar"', () => expect(fnv1a64('foobar')).toBe('85944171f73967e8'))
  test('bytes and string agree for ASCII', () => {
    expect(fnv1a64(new TextEncoder().encode('foobar'))).toBe(fnv1a64('foobar'))
  })
  test('always 16 lowercase hex chars', () => {
    for (const s of ['x', 'longer input '.repeat(50), 'é中']) {
      expect(fnv1a64(s)).toMatch(/^[0-9a-f]{16}$/)
    }
  })
})

describe('canonicalEncode and hashState', () => {
  test('object key order does not matter', () => {
    expect(canonicalEncode({ a: 1, b: [1, 2], c: { y: 1, x: 2 } })).toBe(
      canonicalEncode({ c: { x: 2, y: 1 }, b: [1, 2], a: 1 }),
    )
    expect(hashState({ a: 1, b: 2 })).toBe(hashState({ b: 2, a: 1 }))
  })
  test('array order and values matter', () => {
    expect(hashState([1, 2])).not.toBe(hashState([2, 1]))
    expect(hashState({ a: 1 })).not.toBe(hashState({ a: 2 }))
  })
  test('typed arrays are encoded by content', () => {
    expect(hashState({ v: new Uint32Array([1, 2]) })).toBe(hashState({ v: new Uint32Array([1, 2]) }))
    expect(hashState({ v: new Uint32Array([1, 2]) })).not.toBe(hashState({ v: new Uint32Array([1, 3]) }))
  })
  test('undefined keys are dropped, -0 equals 0', () => {
    expect(hashState({ a: 1, b: undefined })).toBe(hashState({ a: 1 }))
    expect(hashState(-0)).toBe(hashState(0))
  })
  test('non-finite numbers throw (a hash must never hide a NaN)', () => {
    expect(() => hashState({ a: NaN })).toThrow()
    expect(() => hashState([Infinity])).toThrow()
  })
  test('pinned canonical hash', () => {
    expect(canonicalEncode({ b: 2, a: [1, null, 'x'] })).toBe('{"a":[1,null,"x"],"b":2}')
    expect(hashState({ b: 2, a: [1, null, 'x'] })).toBe(fnv1a64('{"a":[1,null,"x"],"b":2}'))
  })
})
