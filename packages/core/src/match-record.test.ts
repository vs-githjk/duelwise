import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { RecordError, decodeRecord, decodeRecordAsync, encodeRecord, encodeRecordAsync, MAX_RECORD_BYTES } from './match-record'
import type { MatchRecordV1 } from './match-record'

function sample(over: Partial<MatchRecordV1> = {}): MatchRecordV1 {
  return {
    schema: 1,
    matchId: 'm-1',
    game: 'four',
    coreVersion: '1',
    agent: { version: 'v1', level: 'easy' },
    seed: 123,
    humanSeat: 0,
    actions: [
      [0, 0, 3],
      [1, 1, 4],
    ],
    result: { winner: 0, score: [1, 0], reason: 'connected four' },
    finalHash: '0123456789abcdef',
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:05:00.000Z',
    device: 'desktop',
    input: 'mouse',
    trainingAllowed: true,
    ...over,
  }
}

describe('encode/decode', () => {
  test('round-trips a small record', () => {
    const r = sample({ humanInputTimesMs: [120, 340] })
    expect(decodeRecord(encodeRecord(r))).toEqual(r)
  })

  test('encoded bytes are gzip', () => {
    const b = encodeRecord(sample())
    expect(b[0]).toBe(0x1f)
    expect(b[1]).toBe(0x8b)
  })

  test('a 20,000-action record round-trips under 200 KB gzipped', () => {
    let x = 12345
    const actions: MatchRecordV1['actions'] = []
    for (let i = 0; i < 20000; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0
      actions.push([i * 2, (i & 1) as 0 | 1, (x >>> 16) % 64])
    }
    const r = sample({ game: 'fighter', actions })
    const b = encodeRecord(r)
    expect(b.length).toBeLessThan(200 * 1024)
    expect(decodeRecord(b)).toEqual(r)
  })

  test('async variants agree with sync', async () => {
    const r = sample()
    const viaAsync = await encodeRecordAsync(r)
    expect(decodeRecord(viaAsync)).toEqual(r)
    expect(await decodeRecordAsync(encodeRecord(r))).toEqual(r)
  })
})

describe('validation', () => {
  const gz = (v: unknown) => new Uint8Array(gzipSync(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))))

  test('not gzip throws RecordError', () => {
    expect(() => decodeRecord(new Uint8Array([1, 2, 3]))).toThrow(RecordError)
    expect(() => decodeRecord(new Uint8Array(0))).toThrow(RecordError)
  })

  test('truncated gzip throws RecordError', () => {
    const b = encodeRecord(sample())
    expect(() => decodeRecord(b.slice(0, b.length - 6))).toThrow(RecordError)
  })

  test('gzip of non-JSON throws RecordError', () => {
    expect(() => decodeRecord(gz('not json{'))).toThrow(RecordError)
  })

  test('wrong schema version throws', () => {
    expect(() => decodeRecord(gz({ ...sample(), schema: 2 }))).toThrow(/schema/)
  })

  const bad: Array<[string, Record<string, unknown>]> = [
    ['unknown game', { game: 'go' }],
    ['bad level', { agent: { version: 'v1', level: 'godlike' } }],
    ['seed not integer', { seed: 1.5 }],
    ['seed not number', { seed: '1' }],
    ['humanSeat 2', { humanSeat: 2 }],
    ['actions not array', { actions: 'x' }],
    ['action wrong arity', { actions: [[0, 0]] }],
    ['action negative tick', { actions: [[-1, 0, 1]] }],
    ['action bad seat', { actions: [[0, 2, 1]] }],
    ['action non-integer', { actions: [[0, 0, 1.5]] }],
    ['result missing', { result: null }],
    ['result winner 2', { result: { winner: 2, score: [0, 0], reason: 'x' } }],
    ['result score wrong', { result: { winner: null, score: [0], reason: 'x' } }],
    ['finalHash not hex16', { finalHash: 'xyz' }],
    ['bad device', { device: 'watch' }],
    ['bad input', { input: 'voice' }],
    ['trainingAllowed not bool', { trainingAllowed: 'yes' }],
    ['humanInputTimesMs not numbers', { humanInputTimesMs: ['a'] }],
    ['matchId empty', { matchId: '' }],
    ['startedAt not a date', { startedAt: 'yesterday' }],
  ]
  for (const [name, patch] of bad) {
    test(`rejects ${name}`, () => {
      expect(() => decodeRecord(gz({ ...sample(), ...patch }))).toThrow(RecordError)
    })
  }

  test('rejects a missing field', () => {
    const { seed: _seed, ...rest } = sample()
    expect(() => decodeRecord(gz(rest))).toThrow(RecordError)
  })

  test('rejects a decompression bomb', () => {
    const big = gz('"' + 'a'.repeat(MAX_RECORD_BYTES + 10) + '"')
    expect(() => decodeRecord(big)).toThrow(RecordError)
  })

  test('encodeRecord refuses to encode an invalid record', () => {
    expect(() => encodeRecord({ ...sample(), seed: 0.5 })).toThrow(RecordError)
  })
})
