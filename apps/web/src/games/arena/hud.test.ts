import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'bun:test'
import { MAP_LIST } from '@duelwise/core/src/games/arena/map'
import { PHASE } from '@duelwise/core/src/games/arena/state'
import { buyMenuVisible, minimapGeometry, roundReason } from './hud'
import { newSightLog, noteShot, reactionLine, resetSightOnTransition, stepSight } from './reaction'

test('the killing step retains the agent sight and first shot', () => {
  expect(resetSightOnTransition(PHASE.LIVE, PHASE.ROUND_END)).toBe(false)
  expect(resetSightOnTransition(PHASE.ROUND_END, PHASE.BUY)).toBe(true)
  const line = reactionLine({ since: 100, shot: [105, 118] }, [105, 118], 130, 300, true)
  expect(line.aiShotAt).toBe(18)
  expect(reactionText(line, 'Easy')).toContain('0.30 s after it first saw you')
})

test('a timeout explains the health rule', () => {
  expect(roundReason(2)).toContain('more health')
})

describe('arena minimap', () => {
  for (const map of MAP_LIST) {
    test(`${map.id}: the outline is the arena bounds and every sim box is drawn, walls apart from cover, y flipped`, () => {
      const g = minimapGeometry(map)
      const b = map.bounds
      expect(g.outline).toBe(`M ${b.x0} ${b.y0} H ${b.x1} V ${b.y1} H ${b.x0} Z`)
      expect(g.boxes.length).toBe(map.json.boxes.length)
      map.json.boxes.forEach((box, i) => {
        const d = g.boxes[i]!
        expect(d.kind).toBe(box.kind === 'cover' ? 'cover' : 'wall')
        expect(d.w).toBe(box.x1 - box.x0)
        expect(d.h).toBe(box.y1 - box.y0)
        // The top edge on screen is the box's far y edge, mirrored inside the bounds.
        expect(d.y).toBe(b.y1 - (box.y1 - b.y0))
      })
    })
  }
})

import { reactionText, Timeline, type DeathLine } from './hud'

describe('round-end reaction line (R30: no more 0.00 s)', () => {
  const line = (o: Partial<DeathLine>): DeathLine => ({ seenAt: 0, aiShotAt: null, youShotAt: null, limitMs: 250, youDied: false, ...o })
  test('a shot after the sight is timed from the sight', () => {
    expect(reactionText(line({ youShotAt: 27 }), 'Hard')).toBe('You fired 0.45 s after you first saw it. At Hard its reaction window is 250 ms.')
    expect(reactionText(line({ youDied: true, aiShotAt: 30 }), 'Hard')).toBe('It fired 0.50 s after it first saw you. At Hard its reaction window is 250 ms.')
  })
  test('a shot before the sight says so instead of printing 0.00 s', () => {
    const t = reactionText(line({ youShotAt: -12 }), 'Easy')
    expect(t).toContain('0.20 s before you first saw it')
    expect(t).not.toContain('0.00')
  })
  test('a shot on the frame of sight and no shot at all are said plainly', () => {
    expect(reactionText(line({ youShotAt: 0 }), 'Easy')).toContain('on the frame you first saw it')
    expect(reactionText(line({ youDied: true }), 'Easy')).toContain('It fired no shot before the kill')
  })
})

describe('buy menu and scoreboard (R30)', () => {
  const base = { playing: true, phase: PHASE.BUY as number | undefined, alive: true, paused: false, board: false }
  test('the buy menu shows in the buy phase and hides while the scoreboard key is held', () => {
    expect(buyMenuVisible(base)).toBe(true)
    expect(buyMenuVisible({ ...base, board: true })).toBe(false)
    expect(buyMenuVisible({ ...base, board: false })).toBe(true)
  })
  test('it stays hidden outside the live buy phase, when dead, paused or not playing', () => {
    expect(buyMenuVisible({ ...base, phase: PHASE.LIVE })).toBe(false)
    expect(buyMenuVisible({ ...base, alive: false })).toBe(false)
    expect(buyMenuVisible({ ...base, paused: true })).toBe(false)
    expect(buyMenuVisible({ ...base, playing: false })).toBe(false)
    expect(buyMenuVisible({ ...base, phase: undefined })).toBe(false)
  })
})

test('a shot just before sight marks sustained firing', () => {
  const line = reactionLine({ since: 100, shot: [null, 103], lastBefore: [null, 98] }, [null, 80], 120, 350, true)
  expect(line.aiAlreadyFiring).toBe(true)
  expect(reactionText(line, 'Easy')).toContain('already firing toward that spot')
  const html = renderToStaticMarkup(createElement(Timeline, { line }))
  expect(html).toContain('ai-shot-mark')
  expect(html).toContain('Already firing when you came into view')
})

test('the real frame sequence marks already firing only when the AI fired before sight', () => {
  const run = (aiFiresAt: number[]) => {
    let log = newSightLog()
    const shots = new Set(aiFiresAt)
    for (let f = 90; f <= 105; f++) {
      log = stepSight(log, f >= 100, true, f)
      if (shots.has(f)) noteShot(log, 1, f)
    }
    return reactionLine(log, [null, aiFiresAt[0] ?? null], 106, 350, true)
  }
  const before = run([98, 103])
  expect(before.aiAlreadyFiring).toBe(true)
  expect(before.aiShotAt).toBe(3)
  expect(run([103]).aiAlreadyFiring).toBe(false)
  expect(reactionText(run([103]), 'Easy')).not.toContain('already firing')
})
