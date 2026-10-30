import { describe, expect, test } from 'bun:test'
import { createState, stepPacked } from '@duelwise/core/src/games/arena/core'
import { PHASE } from '@duelwise/core/src/games/arena/state'
import { opponentVisible } from './DebugRenderer'

describe('opponent visibility in the debug view', () => {
  test('a seat sees the opponent only on a frame the sim gave it a sighting', () => {
    const s = createState(3, { buyFrames: 0 })
    let seenFrames = 0
    let hiddenFrames = 0
    for (let i = 0; i < 600 && s.phase === PHASE.LIVE; i++) {
      stepPacked(s, 0, 0)
      const want = s.players[0].lsKnown === 1 && s.players[0].lsAge === 0
      expect(opponentVisible(s, 0)).toBe(want)
      if (want) seenFrames++
      else hiddenFrames++
    }
    expect(seenFrames + hiddenFrames).toBeGreaterThan(100)
  })

  test('a stale sighting is not a sighting, and a dead seat sees nothing', () => {
    const s = createState(1)
    s.players[0].lsKnown = 1
    s.players[0].lsAge = 5
    expect(opponentVisible(s, 0)).toBe(false)
    s.players[0].lsAge = 0
    expect(opponentVisible(s, 0)).toBe(true)
    s.players[0].alive = 0
    expect(opponentVisible(s, 0)).toBe(false)
    s.players[1].lsKnown = 0
    expect(opponentVisible(s, 1)).toBe(false)
  })
})
