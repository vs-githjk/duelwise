import { describe, expect, test } from 'bun:test'
import { LEVEL_MALLET, RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import { PEOPLE_PROFILES, peopleHands } from '@duelwise/core/src/games/puck/seat-hands'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { PANEL_WEIGHTS } from './people'
import { botSpec, medianLag, pipSpec, playRecorded } from './puck'
import { measurePanel, panelEstimate, panelProxies, panelSpec } from './puck-people'

// The air hockey panel: three test players on people's hands. Each profile fixes delay, noise and hold on the rule mallet.

describe('people profiles', () => {
  test('delay, noise and hold are as specified and fall from beginner to strong', () => {
    // The noise values are frozen literals (the yardstick), not the levels' live aim noise.
    expect(peopleHands('beginner')).toEqual({ delayFrames: 18, noiseSd: 0.035, minHoldFrames: LEVEL_LIMITS.puck.medium.minHoldFrames })
    expect(peopleHands('average')).toEqual({ delayFrames: 15, noiseSd: 0.018, minHoldFrames: LEVEL_LIMITS.puck.hard.minHoldFrames })
    expect(peopleHands('strong')).toEqual({ delayFrames: 12, noiseSd: 0.008, minHoldFrames: LEVEL_LIMITS.puck.champion.minHoldFrames })
  })

  test('retuning a level\'s aim noise does not move the panel', () => {
    const before = PEOPLE_PROFILES.map((p) => peopleHands(p).noiseSd)
    const saved = LEVEL_MALLET.medium.targetNoise
    try {
      LEVEL_MALLET.medium.targetNoise = 0.09
      expect(PEOPLE_PROFILES.map((p) => peopleHands(p).noiseSd)).toEqual(before)
    } finally {
      LEVEL_MALLET.medium.targetNoise = saved
    }
  })

  test('every profile moves the rule mallet (faster than Hard, never past the cap) with its own delay', async () => {
    for (const proxy of PEOPLE_PROFILES) {
      const g = await playRecorded([pipSpec(), panelSpec(proxy)], 5)
      expect(g.seats[1].peakSpeed).toBeGreaterThan(LEVEL_MALLET.hard.speed)
      expect(g.seats[1].peakSpeed).toBeLessThanOrEqual(RULE_MALLET_SPEED + 1e-6)
      expect(medianLag(g.seats[1].lagHist)).toBeGreaterThanOrEqual(peopleHands(proxy).delayFrames)
    }
  }, 300_000)

  test('the strong profile is exactly today human-hands mode (no drift from the published numbers)', async () => {
    const a = await playRecorded([pipSpec(), botSpec('mouse', 'champion', 12, 'human')], 9)
    const b = await playRecorded([pipSpec(), panelSpec('strong')], 9)
    expect(b.winner).toBe(a.winner)
    expect(b.seats[1].peakSpeed).toBe(a.seats[1].peakSpeed)
    expect(JSON.stringify(b.seats)).toBe(JSON.stringify(a.seats))
  }, 300_000)

  test('the same seed gives the same score; the estimate weights the panel 30 / 50 / 20', async () => {
    const run = () => measurePanel(pipSpec(), { games: 1, seedBase: 77_000 })
    const a = await run()
    const b = await run()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const est = panelEstimate(pipSpec(), a)
    const w = PANEL_WEIGHTS
    expect(est.estimate).toBeCloseTo(w.beginner * a.panel.beginner.value + w.average * a.panel.average.value + w.strong * a.panel.strong.value, 9)
    for (const text of Object.values(panelProxies())) expect(text.length).toBeGreaterThan(20)
    expect(est.proxies).toEqual(panelProxies())
  }, 600_000)
})
