import { describe, expect, test } from 'bun:test'
import { fighterCore } from '@duelwise/core/src/games/fighter/core'
import { packInput } from '@duelwise/core/src/games/fighter/input'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { formatClock, highlightsFor } from './highlights'
import { MOVE_INPUT } from './moveInputs'
import { FIRST_ATTACK, MOVES, MOVE_COUNT } from '@duelwise/core/src/games/fighter/moves'

function record(actions: MatchRecordV1['actions']): MatchRecordV1 {
  return { schema: 1, matchId: 'x', game: 'fighter', coreVersion: fighterCore.version, agent: { version: 'v', level: 'easy' }, seed: 7, humanSeat: 0, actions, result: { winner: null, score: [0, 0] } as never, finalHash: '', startedAt: '', endedAt: '', device: 'desktop', input: 'keyboard', trainingAllowed: false }
}

describe('highlights', () => {
  test('formats a clock', () => {
    expect(formatClock(75.9)).toBe('1:15')
    expect(formatClock(3)).toBe('0:03')
  })
  test('a match where seat 0 mashes light finds a hit and is ordered by time', () => {
    const acts: MatchRecordV1['actions'] = []
    for (let t = 200; t < 4000; t += 20) {
      acts.push([t, 0, packInput({ dir: 3, btn: 1 })], [t + 5, 0, packInput({ dir: 3, btn: 0 })])
    }
    const h = highlightsFor(record(acts))
    for (let k = 1; k < h.length; k++) expect(h[k]!.seconds).toBeGreaterThanOrEqual(h[k - 1]!.seconds)
    expect(h.length).toBeLessThanOrEqual(3)
  })
  test('an empty record yields no more than the ones that happened and does not throw', () => {
    expect(() => highlightsFor(record([]), 600)).not.toThrow()
  })
})

describe('move inputs', () => {
  test('every move the list shows has an input', () => {
    for (let id = FIRST_ATTACK; id < MOVE_COUNT; id++) {
      if (MOVES[id]?.hasHit) expect(MOVE_INPUT[id]).toBeDefined()
    }
  })
})
