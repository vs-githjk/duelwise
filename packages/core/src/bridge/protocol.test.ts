import { describe, expect, test } from 'bun:test'
import { FrameReader, ProtocolError, encodeFrame } from './protocol'

describe('bridge frames', () => {
  test('round-trips a header and a payload', () => {
    const payload = new Uint8Array([1, 2, 3, 250, 0, 7])
    const bytes = encodeFrame({ type: 'step', n: 8, tag: 'é' }, payload)
    const r = new FrameReader()
    r.push(bytes)
    const f = r.next()!
    expect(f.header).toEqual({ type: 'step', n: 8, tag: 'é' })
    expect([...f.payload]).toEqual([...payload])
    expect(r.next()).toBeNull()
  })

  test('layout is u32 LE total length, u32 LE header length, JSON header, payload', () => {
    const bytes = encodeFrame({ a: 1 }, new Uint8Array(3))
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const header = new TextEncoder().encode('{"a":1}')
    expect(dv.getUint32(0, true)).toBe(4 + header.length + 3)
    expect(dv.getUint32(4, true)).toBe(header.length)
    expect(bytes.length).toBe(4 + 4 + header.length + 3)
  })

  test('partial reads: one byte at a time yields the frame only at the last byte', () => {
    const bytes = encodeFrame({ type: 'reset', seeds: [1, 2, 3] }, new Uint8Array([9, 8, 7, 6]))
    const r = new FrameReader()
    for (let i = 0; i < bytes.length - 1; i++) {
      r.push(bytes.subarray(i, i + 1))
      expect(r.next()).toBeNull()
    }
    r.push(bytes.subarray(bytes.length - 1))
    const f = r.next()!
    expect(f.header).toEqual({ type: 'reset', seeds: [1, 2, 3] })
    expect([...f.payload]).toEqual([9, 8, 7, 6])
  })

  test('two frames in one chunk, and a frame split across chunks, come out in order', () => {
    const a = encodeFrame({ n: 1 })
    const b = encodeFrame({ n: 2 }, new Uint8Array([5]))
    const c = encodeFrame({ n: 3 })
    const all = new Uint8Array(a.length + b.length + c.length)
    all.set(a, 0)
    all.set(b, a.length)
    all.set(c, a.length + b.length)
    const r = new FrameReader()
    r.push(all.subarray(0, a.length + 3))
    r.push(all.subarray(a.length + 3))
    const got = [...r.drain()].map((f) => f.header.n)
    expect(got).toEqual([1, 2, 3])
  })

  test('empty payload gives an empty Uint8Array', () => {
    const r = new FrameReader()
    r.push(encodeFrame({ type: 'hello' }))
    expect(r.next()!.payload.length).toBe(0)
  })

  test('a header length beyond the frame throws ProtocolError', () => {
    const bytes = encodeFrame({ a: 1 })
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 9999, true)
    const r = new FrameReader()
    r.push(bytes)
    expect(() => r.next()).toThrow(ProtocolError)
  })

  test('an oversized length prefix throws before buffering the body', () => {
    const r = new FrameReader(1024)
    const bad = new Uint8Array(8)
    new DataView(bad.buffer).setUint32(0, 5000, true)
    r.push(bad)
    expect(() => r.next()).toThrow(ProtocolError)
  })

  test('a header that is not JSON throws ProtocolError', () => {
    const bytes = encodeFrame({ a: 1 })
    bytes[8] = 0x7b + 1 // corrupt the opening brace
    const r = new FrameReader()
    r.push(bytes)
    expect(() => r.next()).toThrow(ProtocolError)
  })
})
