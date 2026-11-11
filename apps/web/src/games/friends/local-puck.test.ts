import { describe, expect, mock, test } from 'bun:test'
import { CAP_FRAMES, GOALS_TO_WIN, HARD_CAP_FRAMES, NO_INPUT, RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import { createState } from '@duelwise/core/src/games/puck/state'
import { bottomPerson, localPuckResult, puckTally, reasonOfPuck, startLocalPuck, stepLocalPuck } from './local-puck'
import { PLAYER_ONE, PLAYER_TWO } from './useLocalDuel'

// The recorder and the server calls a rated match uses. A local Glasscut match must never touch them.
const calls: string[] = []
const spy = (name: string) => () => {
  calls.push(name)
  return Promise.reject(new Error(`${name} must not be called by a friend game`))
}
mock.module('../../lib/match-recorder', () => ({ useMatchRecorder: spy('useMatchRecorder'), detectDevice: () => 'desktop' }))
mock.module('../../lib/open-match', () => ({ openMatch: spy('openMatch') }))

describe('a local Glasscut match', () => {
  test('runs to a result with no rated-match path and the rule limits on both seats', () => {
    const s = startLocalPuck(42)
    const plain = createState(42)
    for (const seat of [0, 1]) {
      expect(s.m[seat]!.speed).toBe(plain.m[seat]!.speed)
      expect(s.m[seat]!.accel).toBe(plain.m[seat]!.accel)
      expect(s.m[seat]!.speed).toBe(RULE_MALLET_SPEED)
    }
    expect(localPuckResult(s)).toBeNull()
    for (let i = 0; i < HARD_CAP_FRAMES + 10 && s.matchOver === 0; i++) stepLocalPuck(s, NO_INPUT, NO_INPUT)
    const r = localPuckResult(s)
    expect(r).not.toBeNull()
    expect(r!.reason).toBe(reasonOfPuck(s.endReason))
    expect(s.frame).toBeGreaterThanOrEqual(CAP_FRAMES)
    expect(calls).toEqual([])
  })

  test('lead starts both scores level and never above the last goal', () => {
    const five = startLocalPuck(1, 5)
    expect([five.score[0], five.score[1]]).toEqual([5, 5])
    const s = startLocalPuck(1, 99)
    expect([s.score[0], s.score[1]]).toEqual([GOALS_TO_WIN - 1, GOALS_TO_WIN - 1])
    const n = startLocalPuck(1, 0)
    expect([n.score[0], n.score[1]]).toEqual([0, 0])
  })

  test('sides swap every rematch and the tally follows the person, not the seat', () => {
    expect([0, 1, 2, 3].map((g) => bottomPerson(PLAYER_ONE, g))).toEqual([PLAYER_ONE, PLAYER_TWO, PLAYER_ONE, PLAYER_TWO])
    expect(puckTally([
      { winner: 0, bottom: PLAYER_ONE },
      { winner: 0, bottom: PLAYER_TWO },
      { winner: null, bottom: PLAYER_ONE },
      { winner: 1, bottom: PLAYER_TWO },
    ])).toEqual({ one: 2, two: 1, draws: 1 })
  })
})
