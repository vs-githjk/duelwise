import { describe, expect, test } from 'bun:test'
import type { MatchRecordV1 } from '../match-record'
import type { Seat } from '../types'
import { holdemCore, type HoldemAction } from '../games/holdem/core'
import { newFilterContext, type FilterRow } from './common'
import { CHESS_MIN_HUMAN_MOVES, HOLDEM_MIN_HANDS, hasHumanFilter, humanFilterMatch } from './human'
import { hasFilter } from './index'

function rec(over: Partial<MatchRecordV1>): MatchRecordV1 {
  return {
    schema: 1, matchId: 'm-real-1', game: 'chess', coreVersion: '1', agent: { version: 'v1', level: 'hard' }, seed: 5, humanSeat: 0, actions: [],
    result: { winner: 0, score: [1, 0], reason: 'x' }, finalHash: '0123456789abcdef', startedAt: '2026-10-22T08:00:00.000Z', endedAt: '2026-10-22T08:30:00.000Z',
    device: 'desktop', input: 'mouse', trainingAllowed: true, ...over,
  }
}
const row = (r: MatchRecordV1): FilterRow => ({ id: r.matchId, game: r.game, status: 'finished', recordValid: true, trainingAllowed: true, filterFlags: null, record: r })
const chessActions = (humanMoves: number): MatchRecordV1['actions'] => Array.from({ length: humanMoves * 2 }, (_, i) => [i, (i % 2) as Seat, 800 + i] as [number, Seat, number])

function holdem(hands: number, humanFolds: boolean): MatchRecordV1 {
  let s = holdemCore.init(9, { hands: 5 })
  const actions: MatchRecordV1['actions'] = []
  let n = 0
  while (!holdemCore.terminal(s) && n < hands * 10) {
    const seat = s.actor
    const toCall = Math.max(s.bet[0], s.bet[1]) - s.bet[seat]
    const a: HoldemAction = humanFolds && seat === 0 && toCall > 0 ? { type: 'fold' } : humanFolds && seat === 1 && s.street === 0 && s.bet[1] < 6 && s.canRaise[1] ? { type: 'raise', to: 6 } : { type: 'call' }
    actions.push([n++, seat, holdemCore.encodeAction(a)])
    s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
    if (s.hand >= hands) break
  }
  return rec({ game: 'holdem', coreVersion: 'holdem-1', actions, options: { hands: 5 } })
}

describe('human-data filters', () => {
  test('only four, chess and holdem have them, and the registered retrain filters are unchanged', () => {
    expect(hasHumanFilter('four') && hasHumanFilter('chess') && hasHumanFilter('holdem')).toBe(true)
    expect(hasHumanFilter('word')).toBe(false)
    expect(() => humanFilterMatch(row(rec({ game: 'word' })), newFilterContext())).toThrow()
    expect(hasFilter('chess')).toBe(false)
    expect(hasFilter('holdem')).toBe(false)
  })

  test('chess: eight human moves are needed, and a median input time under 150 ms is a script', () => {
    const ok = humanFilterMatch(row(rec({ actions: chessActions(CHESS_MIN_HUMAN_MOVES) })), newFilterContext())
    expect(ok.ok).toBe(true)
    const short = humanFilterMatch(row(rec({ actions: chessActions(CHESS_MIN_HUMAN_MOVES - 1) })), newFilterContext())
    expect(short).toMatchObject({ ok: false, reason: 'too_short' })
    const fast = humanFilterMatch(row(rec({ actions: chessActions(10), humanInputTimesMs: Array(10).fill(40) })), newFilterContext())
    expect(fast).toMatchObject({ ok: false, reason: 'inhuman_timing' })
    const noTimes = humanFilterMatch(row(rec({ actions: chessActions(10) })), newFilterContext())
    expect(noTimes.ok).toBe(true)
  })

  test('chess: a human playing Black counts the Black moves', () => {
    const black = chessActions(10).map(([t, s, a]) => [t, (1 - s) as Seat, a] as [number, Seat, number])
    expect(humanFilterMatch(row(rec({ actions: black, humanSeat: 1 })), newFilterContext()).ok).toBe(true)
  })

  test('holdem: at least three hands with a human decision, and not a player who folds every hand', () => {
    expect(HOLDEM_MIN_HANDS).toBe(3)
    expect(humanFilterMatch(row(holdem(5, false)), newFilterContext()).ok).toBe(true)
    expect(humanFilterMatch(row(holdem(5, true)), newFilterContext())).toMatchObject({ ok: false, reason: 'inhuman_timing' })
    expect(humanFilterMatch(row(holdem(2, false)), newFilterContext())).toMatchObject({ ok: false, reason: 'too_short' })
  })

  test('the common rules still come first, and a duplicate is caught', () => {
    const r = rec({ actions: chessActions(10), trainingAllowed: false })
    expect(humanFilterMatch({ ...row(r), trainingAllowed: false }, newFilterContext())).toMatchObject({ ok: false, reason: 'training_not_allowed' })
    const ctx = newFilterContext()
    const a = row(rec({ actions: chessActions(10) }))
    expect(humanFilterMatch(a, ctx).ok).toBe(true)
    expect(humanFilterMatch({ ...a, id: 'other' }, ctx)).toMatchObject({ ok: false, reason: 'duplicate' })
  })
})
