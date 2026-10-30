import { describe, expect, test } from 'bun:test'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { realtimeCoaching, realtimeMoments, type RealtimeFacts } from './realtime'

const facts: RealtimeFacts = {
  bursts: [{ round: 1, secondsLeft: 20, lost: 1500 }, null],
  rounds: [
    { round: 1, winner: 0, reason: 1, health: [4500, 0], wins: [1, 0] },
    { round: 2, winner: 1, reason: 1, health: [0, 3200], wins: [1, 1] },
  ],
}
const record = (game: 'fighter' | 'arena') => ({ game, humanSeat: 0, result: { winner: 0 } }) as MatchRecordV1

describe('real-time report copy', () => {
  test('fighter coaching is omitted for arena even when a burst exists', () => {
    expect(realtimeCoaching(record('fighter'), facts, 'Rival')).not.toBeNull()
    expect(realtimeCoaching(record('arena'), facts, 'Rival')).toBeNull()
  })
  test('round health uses grouped numbers in private and public copy', () => {
    const moments = realtimeMoments(record('arena'), facts, 'Rival')
    expect(moments[0]!.text).toContain('4,500 health left')
    expect(moments[0]!.publicText).toContain('4,500 health left')
    expect(moments[1]!.text).toContain('3,200 health left')
  })
})
