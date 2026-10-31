import { describe, expect, test } from 'bun:test'
import { holdemCore, type HoldemAction, type HoldemState } from '@duelwise/core/src/games/holdem/core'
import type { Seat } from '@duelwise/core/src/types'
import type { HumanRow } from './export-human'
import { buildProfiles } from './profile-holdem'

function row(id: string, player: string, seed: number, profileOk: boolean | null, humanFolds = false): HumanRow {
  let s: HoldemState = holdemCore.init(seed, { hands: 5 })
  const actions: HumanRow['actions'] = []
  let tick = 0
  while (!holdemCore.terminal(s)) {
    const seat = s.actor
    const toCall = Math.max(s.bet[0], s.bet[1]) - s.bet[seat]
    const a: HoldemAction =
      humanFolds && seat === 0 && toCall > 0 ? { type: 'fold' } : humanFolds && seat === 1 && s.street === 0 && s.bet[1] < 6 && s.canRaise[1] ? { type: 'raise', to: 6 } : { type: 'call' }
    actions.push([tick++, seat as Seat, holdemCore.encodeAction(a)])
    s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
  }
  return {
    id, game: 'holdem', player, traffic: 'human', level: 'champion', agentVersion: 'v1', humanSeat: 0, outcome: 'loss', weight: 0.3, practice: false, left: false,
    startedAt: '2026-10-30T08:00:00.000Z', day: '2026-10-30', elo: null, profileOk, device: 'phone', input: 'touch', seed, options: { hands: 5 },
    result: holdemCore.result(s)!, actions, humanInputTimesMs: null,
  }
}

describe('buildProfiles', () => {
  test('adds a player\'s matches together and leaves out players who switched profiles off', () => {
    const { profiles, summary } = buildProfiles([row('a1', 'p_a', 1, true), row('a2', 'p_a', 2, true, true), row('b1', 'p_b', 3, false), row('c1', 'p_c', 4, true)])
    expect(profiles.map((p) => p.player).sort()).toEqual(['p_a', 'p_c'])
    const a = profiles.find((p) => p.player === 'p_a')!.profile
    expect(a.matches).toBe(2)
    expect(a.hands).toBe(10)
    expect(summary.players).toBe(2)
    expect(summary.optedOutMatches).toBe(1)
    expect(summary.confidentPlayers).toBe(0)
    expect(summary.hands).toBe(15)
  })

  test('opted-out data never reaches a profile, even partly', () => {
    const { profiles } = buildProfiles([row('b1', 'p_b', 3, false), row('b2', 'p_b', 5, false)])
    expect(profiles).toEqual([])
  })

  test('refuses to profile when the database has no opt-out switch', () => {
    expect(() => buildProfiles([row('a1', 'p_a', 1, null)])).toThrow(/opt-out/)
  })

  test('a player who folds to every raise reads as tight after shrinkage, not as a perfect 0', () => {
    const { profiles } = buildProfiles([row('a2', 'p_a', 2, true, true)])
    const p = profiles[0]!.profile
    expect(p.pfr.raw).toBe(0)
    expect(p.pfr.value).toBeGreaterThan(0)
    expect(p.pfr.value).toBeLessThan(0.5)
  })
})
