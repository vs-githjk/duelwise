import { describe, expect, test } from 'bun:test'
import { NO_INPUT, PHASE, PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import { stepState } from '@duelwise/core/src/games/puck/core'
import { blankState, createState } from '@duelwise/core/src/games/puck/state'
import { summaryLine, summaryOf } from './summary'

describe('Glasscut match summary', () => {
  test('reads each seat\'s counters from the sim\'s stats, seat 0 first', () => {
    const s = blankState()
    s.stats[PUCK_EVENTS.shot - 1] = 9
    s.stats[PUCK_EVENTS.save - 1] = 5
    s.stats[6 + PUCK_EVENTS.shot - 1] = 4
    expect(summaryOf(s, 0)).toMatchObject({ shots: 9, saves: 5 })
    expect(summaryOf(s, 1)).toMatchObject({ shots: 4, saves: 0 })
  })

  test('says the numbers in a calm line, goals first, singular where it should be, and leaves out the zeros it need not name', () => {
    expect(summaryLine({ goals: 7, shots: 9, saves: 5, posts: 0, nearMisses: 0, fouls: 0 })).toBe('7 goals, 9 straight shots on target, 5 saves.')
    expect(summaryLine({ goals: 1, shots: 1, saves: 1, posts: 1, nearMisses: 1, fouls: 0 })).toBe('1 goal, 1 straight shot on target, 1 save, 1 post, 1 near miss.')
    expect(summaryLine({ goals: 1, shots: 2, saves: 0, posts: 2, nearMisses: 3, fouls: 0 })).toBe('1 goal, 2 straight shots on target, 0 saves, 2 posts, 3 near misses.')
  })

  test('the real sim counts a shot at the mallet touch only: a goal the puck reaches without one (a bank or a long contact) is a goal and no shot', () => {
    const s = createState(5)
    s.phase = PHASE.LIVE
    s.m[0]!.x = 0.1; s.m[0]!.y = 0.1; s.m[0]!.tx = 0.1; s.m[0]!.ty = 0.1
    s.m[1]!.x = 0.9; s.m[1]!.y = 1.9; s.m[1]!.tx = 0.9; s.m[1]!.ty = 1.9
    s.lastTouch = 0
    s.px = 0.5; s.py = 1.5; s.pvx = 0; s.pvy = 3
    for (let i = 0; i < 200 && s.score[0] === 0; i++) stepState(s, [NO_INPUT, NO_INPUT])
    const m = summaryOf(s, 0)
    expect(m).toMatchObject({ goals: 1, shots: 0 })
    expect(summaryLine(m)).toBe('1 goal, 0 straight shots on target, 0 saves.')
  })
})
