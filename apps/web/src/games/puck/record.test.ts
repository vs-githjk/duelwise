import { describe, expect, test } from 'bun:test'
import { GRID, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { createBot } from '@duelwise/core/src/games/puck/bots'
import { observe, puckCore } from '@duelwise/core/src/games/puck/core'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import { replay } from '@duelwise/core/src/replay'
import type { Level } from '@duelwise/core/src/product'
import { createMatchRecorder } from '../../lib/match-recorder'
import { PuckMatch } from './loop'

// A page match is recorded the way usePuckMatch does it (both seats' inputs, changed values only) and must replay to
// the same result and hash, whatever level limits the opponent's mallet played under.
async function playAndRecord(seed: number, level: Level, claimed: Level = level) {
  const m = new PuckMatch(seed, level)
  const human = createBot('striker', seed + 1)
  const rec = createMatchRecorder({ game: 'puck', matchId: `t-${seed}-${level}`, seed, humanSeat: 0, agent: { version: 'preview', level: claimed }, trainingAllowed: false, device: 'desktop', input: 'mouse' })
  while (!m.over) {
    const frame = m.s.frame
    const code = frame % 2 === 0 ? (() => { const t = human.act(observe(m.s, 0)); return unitToCell(t[0]) + GRID * unitToCell(t[1]) })() : NO_INPUT
    m.tick(code)
    rec.recordAction(frame, 0, code)
    rec.recordAction(frame, 1, m.inputs[1])
  }
  return rec.finish(puckCore, m.s)
}

describe('a Glasscut page match replays', () => {
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    test(`at ${level}: the record reproduces the result and the final hash`, async () => {
      const out = await playAndRecord(11, level)
      expect(out.error).toBeUndefined()
      expect(out.ok).toBe(true)
      expect(replay(out.record).ok).toBe(true)
    })
  }

  test('a record that claims another level than the one played does not verify', async () => {
    const out = await playAndRecord(11, 'easy', 'champion')
    expect(out.ok).toBe(false)
  })
})
