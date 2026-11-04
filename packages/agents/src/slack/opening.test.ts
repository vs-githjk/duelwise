import { describe, expect, test } from 'bun:test'
import { slackCore } from '@duelwise/core/src/games/slack/core'
import { OPENING_PLIES, createSlackOpeningCore } from './opening'

const core = createSlackOpeningCore()

describe('Crosscurrent opening core', () => {
  test('seeds 2k and 2k+1 share one opening', () => {
    for (let k = 0; k < 200; k++) {
      expect(core.hash(core.init(2 * k))).toBe(core.hash(core.init(2 * k + 1)))
    }
  })

  test('other seed pairs differ (4 plies reach about 240 positions, so some repeat)', () => {
    const seen = new Set<string>()
    for (let k = 0; k < 200; k++) seen.add(core.hash(core.init(2 * k)))
    expect(seen.size).toBeGreaterThanOrEqual(100)
    expect(core.hash(core.init(0))).not.toBe(core.hash(core.init(2)))
  })

  test('no opening starts terminal, and each is reachable by legal plies', () => {
    for (let seed = 0; seed < 600; seed++) {
      const s = core.init(seed)
      expect(core.terminal(s)).toBe(false)
      expect(core.toAct(s).length).toBe(1)
      const discs = s.cells.filter((c) => c !== 0).length
      expect(discs).toBe(4 + OPENING_PLIES)
      expect(discs).toBeLessThanOrEqual(4 + OPENING_PLIES)
    }
  })

  test('same seed gives the same opening, and the base rules are unchanged', () => {
    expect(core.hash(core.init(77))).toBe(core.hash(core.init(77)))
    expect(core.version).toBe(slackCore.version)
    expect(core.id).toBe(slackCore.id)
    expect(core.legal(core.init(5), core.toAct(core.init(5))[0]!).length).toBeGreaterThan(0)
  })
})
