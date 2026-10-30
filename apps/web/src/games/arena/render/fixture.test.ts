import { describe, expect, test } from 'bun:test'
import { EV } from '@duelwise/core/src/games/arena/state.ts'
import { buildFixture, FIXTURE_FRAMES } from './fixture'

describe('arena render fixture', () => {
  test('is deterministic, long enough, and has shots and a hit to draw', () => {
    const a = buildFixture()
    const b = buildFixture()
    expect(a.length).toBe(FIXTURE_FRAMES + 1)
    expect(a[a.length - 1]!.rng).toEqual(b[b.length - 1]!.rng)
    expect(a[700]!.players[0].x).toBe(b[700]!.players[0].x)
    let fired = 0
    let hits = 0
    for (const s of a) {
      for (const p of s.players) {
        if (p.events & EV.FIRED) fired++
        if (p.events & EV.HIT_DEALT) hits++
      }
    }
    expect(fired).toBeGreaterThan(20)
    expect(hits).toBeGreaterThan(0)
  })
})
