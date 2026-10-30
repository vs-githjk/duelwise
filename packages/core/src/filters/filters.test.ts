import { describe, expect, test } from 'bun:test'
import type { MatchRecordV1 } from '../match-record'
import { filterMatch, filterMatches, fourStartPositions, hasFilter, newFilterContext, NoFilterError, type FilterRow, type RejectReason } from './index'

const MOVES = [3, 3, 2, 4, 3, 2, 4, 1, 3, 5, 0, 6]

function record(over: Partial<MatchRecordV1> = {}): MatchRecordV1 {
  const actions = MOVES.map((c, i) => [i, (i % 2) as 0 | 1, c] as [number, 0 | 1, number])
  return {
    schema: 1,
    matchId: 'm-real-1',
    game: 'four',
    coreVersion: '1',
    agent: { version: 'v1', level: 'hard' },
    seed: 77,
    humanSeat: 0,
    actions,
    humanInputTimesMs: [820, 1310, 640, 2200, 905, 1500],
    result: { winner: 1, score: [0, 1], reason: 'four' },
    finalHash: '0123456789abcdef',
    startedAt: '2026-10-22T08:00:00.000Z',
    endedAt: '2026-10-22T08:03:00.000Z',
    device: 'desktop',
    input: 'mouse',
    trainingAllowed: true,
    ...over,
  }
}

function row(over: Partial<FilterRow> = {}, rec: Partial<MatchRecordV1> | null = {}): FilterRow {
  return {
    id: 'm-real-1',
    game: 'four',
    status: 'finished',
    recordValid: true,
    trainingAllowed: true,
    filterFlags: null,
    record: rec === null ? null : record(rec),
    ...over,
  }
}

const reasonOf = (r: FilterRow, ctx = newFilterContext()): RejectReason | 'ok' => {
  const res = filterMatch(r, ctx)
  return res.ok ? 'ok' : res.reason
}

describe('training filters for four', () => {
  test('a normal human match passes', () => {
    expect(reasonOf(row())).toBe('ok')
  })

  test('unfinished: still started, or no record', () => {
    expect(reasonOf(row({ status: 'started' }))).toBe('unfinished')
    expect(reasonOf(row({}, null))).toBe('unfinished')
  })

  test('abandoned: abandoned and resigned matches, and a stray resigned flag', () => {
    expect(reasonOf(row({ status: 'abandoned' }))).toBe('abandoned')
    expect(reasonOf(row({ status: 'resigned' }))).toBe('abandoned')
    expect(reasonOf(row({ filterFlags: { resigned: true } }))).toBe('abandoned')
  })

  test('replay invalid: failed or never checked', () => {
    expect(reasonOf(row({ recordValid: false }))).toBe('replay_invalid')
    expect(reasonOf(row({ recordValid: null }))).toBe('replay_invalid')
  })

  test('training not allowed: on the row or inside the record', () => {
    expect(reasonOf(row({ trainingAllowed: false }))).toBe('training_not_allowed')
    expect(reasonOf(row({}, { trainingAllowed: false }))).toBe('training_not_allowed')
  })

  test('too short: fewer than 8 plies, or fewer than 3 human moves', () => {
    const short = MOVES.slice(0, 7).map((c, i) => [i, (i % 2) as 0 | 1, c] as [number, 0 | 1, number])
    expect(reasonOf(row({}, { actions: short, humanInputTimesMs: [800, 900, 1000, 1100] }))).toBe('too_short')
    const fewHuman = MOVES.slice(0, 10).map((c, i) => [i, 1, c] as [number, 0 | 1, number])
    expect(reasonOf(row({}, { actions: fewHuman, humanInputTimesMs: [] }))).toBe('too_short')
  })

  test('duplicate: the same seed and actions uploaded twice; the earlier copy is kept', () => {
    const ctx = newFilterContext()
    expect(reasonOf(row({ id: 'a' }, { matchId: 'a' }), ctx)).toBe('ok')
    expect(reasonOf(row({ id: 'b' }, { matchId: 'b' }), ctx)).toBe('duplicate')
    expect(reasonOf(row({ id: 'c' }, { matchId: 'c', seed: 78 }), ctx)).toBe('ok')
  })

  test('synthetic: flagged, or made by a test, dev tool or bot', () => {
    expect(reasonOf(row({ filterFlags: { synthetic: true } }))).toBe('synthetic')
    expect(reasonOf(row({ id: 'test-1' }, { matchId: 'test-1' }))).toBe('synthetic')
    expect(reasonOf(row({ id: 'dev-9' }, { matchId: 'dev-9' }))).toBe('synthetic')
  })

  test('inhuman timing: too fast, all alike, or missing', () => {
    expect(reasonOf(row({}, { humanInputTimesMs: [20, 30, 25, 18, 40, 22] }))).toBe('inhuman_timing')
    expect(reasonOf(row({}, { humanInputTimesMs: [500, 505, 510, 500, 508, 502] }))).toBe('inhuman_timing')
    expect(reasonOf(row({}, { humanInputTimesMs: undefined }))).toBe('inhuman_timing')
    expect(reasonOf(row({}, { humanInputTimesMs: [800, 900] }))).toBe('inhuman_timing')
  })

  test('the first failing rule names the reason (abandoned beats invalid)', () => {
    expect(reasonOf(row({ status: 'abandoned', recordValid: false }))).toBe('abandoned')
  })

  test('filterMatches counts every reason and keeps the clean matches in order', () => {
    const rows = [
      row({ id: 'k1' }, { matchId: 'k1', seed: 1 }),
      row({ id: 'x1', status: 'abandoned' }, { matchId: 'x1', seed: 2 }),
      row({ id: 'k2' }, { matchId: 'k2', seed: 3 }),
      row({ id: 'x2', recordValid: false }, { matchId: 'x2', seed: 4 }),
      row({ id: 'x3' }, { matchId: 'x3', seed: 3 }),
    ]
    const rep = filterMatches(rows)
    expect(rep.kept.map((r) => r.id)).toEqual(['k1', 'k2'])
    expect(rep.rejected.map((r) => [r.id, r.reason])).toEqual([['x1', 'abandoned'], ['x2', 'replay_invalid'], ['x3', 'duplicate']])
    expect(rep.counts.abandoned).toBe(1)
    expect(rep.counts.synthetic).toBe(0)
  })

  test('games without an adapter have no filter', () => {
    expect(hasFilter('four')).toBe(true)
    expect(hasFilter('chess')).toBe(false)
    expect(() => filterMatch(row({ game: 'chess' }))).toThrow(NoFilterError)
  })

  test('start positions are the human-reached prefixes after the opening, never the finished game', () => {
    const starts = fourStartPositions(record())
    expect(starts[0]).toEqual(MOVES.slice(0, 4))
    expect(starts.at(-1)).toEqual(MOVES.slice(0, MOVES.length - 2))
    expect(starts.length).toBe(MOVES.length - 1 - 4)
  })
})
