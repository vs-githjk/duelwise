import { describe, expect, test } from 'bun:test'
import { POSSESSION_FRAMES, PUCK_R } from './constants'
import { OBS_FEATURES, writeSeatView } from './env'
import { createState } from './state'

describe('possession feature', () => {
  test('follows the possession half (with its hysteresis), not the puck side of the centre line', () => {
    const s = createState(1)
    // Possession began in half 0; the puck drifted to py 1 + PUCK_R / 2, inside the hysteresis band.
    s.possHalf = 0
    s.possFrames = 403
    s.py = 1 + PUCK_R / 2
    const out = new Float32Array(OBS_FEATURES)
    writeSeatView(s, 0, out, 0)
    expect(out[12]).toBeCloseTo(403 / POSSESSION_FRAMES, 5)
    writeSeatView(s, 1, out, 0)
    expect(out[12]).toBeCloseTo(-403 / POSSESSION_FRAMES, 5)
  })
})

describe('puck speed scale', () => {
  test('the observation divides puck speed by the frozen 4.5 the nets were trained on, not the sim cap', () => {
    const s = createState(1)
    s.pvx = 2.25; s.pvy = -1.125
    const out = new Float32Array(OBS_FEATURES)
    writeSeatView(s, 0, out, 0)
    expect(out[2]).toBeCloseTo(0.5, 6)
    expect(out[3]).toBeCloseTo(-0.25, 6)
  })
})
