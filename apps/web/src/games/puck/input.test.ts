import { describe, expect, test } from 'bun:test'
import { MALLET_R, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { cellToUnit, decodePuckInput } from '@duelwise/core/src/games/puck/input'
import { EDGE_GUARD, HUD_H, MalletControl, fitLayout, screenToWorld, worldToScreen } from './input'

const portrait = fitLayout(390, 844, true)
const landscape = fitLayout(844, 390, true)
const desktop = fitLayout(1440, 900, false)

function ctl(layout = portrait, opts?: ConstructorParameters<typeof MalletControl>[1]): MalletControl {
  const c = new MalletControl(layout, opts)
  c.reset(0.5, 0.3)
  return c
}

describe('layout', () => {
  test('portrait puts your goal at the bottom, landscape at the left, and the maps invert', () => {
    expect(portrait.landscape).toBe(false)
    expect(landscape.landscape).toBe(true)
    for (const l of [portrait, landscape, desktop]) {
      const [sx, sy] = worldToScreen(l, 0.3, 0.7)
      const [wx, wy] = screenToWorld(l, sx, sy)
      expect(wx).toBeCloseTo(0.3, 9)
      expect(wy).toBeCloseTo(0.7, 9)
    }
    expect(worldToScreen(portrait, 0.5, 0.2)[1]).toBeGreaterThan(worldToScreen(portrait, 0.5, 1.8)[1])
    expect(worldToScreen(landscape, 0.5, 0.2)[0]).toBeLessThan(worldToScreen(landscape, 0.5, 1.8)[0])
  })
  test('the table fits the screen with a thumb strip on a phone', () => {
    for (const [l, w, h] of [[portrait, 390, 844], [landscape, 844, 390], [fitLayout(360, 780, true), 360, 780], [fitLayout(780, 360, true), 780, 360]] as const) {
      const tw = l.landscape ? l.scale * 2 : l.scale
      const th = l.landscape ? l.scale : l.scale * 2
      expect(l.x).toBeGreaterThanOrEqual(0)
      expect(l.y).toBeGreaterThanOrEqual(0)
      expect(l.x + tw).toBeLessThanOrEqual(w)
      expect(l.y + th).toBeLessThanOrEqual(h)
    }
    // Portrait: at least 100 px of strip below the table. Landscape: at least 80 px left of it.
    expect(844 - (portrait.y + portrait.scale * 2)).toBeGreaterThanOrEqual(100)
    expect(landscape.x).toBeGreaterThanOrEqual(80)
  })
})

describe('touch is a relative drag', () => {
  test('finger movement maps 1:1 in table units and touchdown never moves the mallet', () => {
    const c = ctl()
    const s = portrait.scale
    expect(c.down(1, 'touch', 120, 700, 0)).toBe(true)
    expect(c.target()).toEqual([0.5, 0.3])
    expect(c.takeCode()).toBe(NO_INPUT)
    c.move(1, 'touch', 120 + s * 0.1, 700 - s * 0.2, 16)
    const [tx, ty] = c.target()!
    expect(tx).toBeCloseTo(0.6, 9)
    expect(ty).toBeCloseTo(0.5, 9)
    const d = decodePuckInput(c.takeCode())!
    expect(cellToUnit(d.tx)).toBeCloseTo(0.6, 2)
    expect(cellToUnit(d.ty)).toBeCloseTo(0.5, 2)
    expect(c.takeCode()).toBe(NO_INPUT)
  })
  test('a second finger is ignored until the first lifts', () => {
    const c = ctl()
    c.down(1, 'touch', 100, 700, 0)
    expect(c.down(2, 'touch', 300, 700, 1)).toBe(false)
    c.move(2, 'touch', 300, 600, 2)
    expect(c.target()).toEqual([0.5, 0.3])
    c.up(2)
    c.move(1, 'touch', 100 + portrait.scale * 0.05, 700, 3)
    expect(c.target()![0]).toBeCloseTo(0.55, 9)
    c.up(1)
    expect(c.down(2, 'touch', 300, 700, 4)).toBe(true)
  })
  test('landscape: finger right is toward the opponent, finger down is your right hand', () => {
    const c = ctl(landscape)
    const s = landscape.scale
    c.down(1, 'touch', 100, 200, 0)
    c.move(1, 'touch', 100 + s * 0.2, 200 + s * 0.1, 16)
    const [tx, ty] = c.target()!
    expect(tx).toBeCloseTo(0.6, 9)
    expect(ty).toBeCloseTo(0.5, 9)
  })
  test('the target stops at the centre line and the walls, and pushing past them stores nothing', () => {
    const c = ctl()
    c.down(1, 'touch', 200, 700, 0)
    c.move(1, 'touch', 200, -5000, 16)
    expect(c.target()![1]).toBeCloseTo(1 - MALLET_R, 9)
    // 10 px back from the limit moves the target 10 px, not 5000 px of wind-up.
    c.move(1, 'touch', 200, -5000 + 10, 32)
    expect(c.target()![1]).toBeCloseTo(1 - MALLET_R - 10 / portrait.scale, 9)
    c.move(1, 'touch', -9000, -5000 + 10, 48)
    expect(c.target()![0]).toBeCloseTo(MALLET_R, 9)
  })
  test('rotating mid-drag re-anchors the finger, so the mallet does not jump', () => {
    const c = ctl()
    c.down(1, 'touch', 100, 700, 0)
    c.move(1, 'touch', 100 + portrait.scale * 0.1, 700, 16)
    const before = [...c.target()!]
    c.setLayout(landscape)
    c.move(1, 'touch', 600, 50, 32)
    expect(c.target()).toEqual(before as [number, number])
    c.move(1, 'touch', 600 + landscape.scale * 0.1, 50, 48)
    expect(c.target()![1]).toBeCloseTo(before[1]! + 0.1, 9)
  })
  test('peak finger speed in table widths a second', () => {
    const c = ctl()
    c.down(1, 'touch', 100, 700, 0)
    c.move(1, 'touch', 100 + portrait.scale * 0.1, 700, 20)
    expect(c.peakSpeed).toBeCloseTo(5, 6)
    c.move(1, 'touch', 100 + portrait.scale * 0.11, 700, 40)
    expect(c.peakSpeed).toBeCloseTo(5, 6)
  })
  test('direct mode (dev compare) puts the mallet above the finger from touchdown', () => {
    const c = ctl(portrait, { direct: true, offsetPx: 80 })
    const [fx, fy] = worldToScreen(portrait, 0.4, 0.5)
    c.down(1, 'touch', fx, fy + 80, 0)
    expect(c.target()![0]).toBeCloseTo(0.4, 9)
    expect(c.target()![1]).toBeCloseTo(0.5, 9)
  })
})

describe('mouse is absolute inside your half', () => {
  test('the mallet goes where the cursor is, with no button needed', () => {
    const c = ctl(desktop)
    const [sx, sy] = worldToScreen(desktop, 0.25, 0.6)
    expect(c.move(7, 'mouse', sx, sy, 0)).toBe(true)
    expect(c.target()![0]).toBeCloseTo(0.25, 9)
    expect(c.target()![1]).toBeCloseTo(0.6, 9)
  })
  test('clamps at the line and the walls however far the cursor goes', () => {
    const c = ctl(desktop)
    const [sx, sy] = worldToScreen(desktop, 0.5, 1.7)
    c.move(7, 'mouse', sx, sy, 0)
    expect(c.target()![1]).toBeCloseTo(1 - MALLET_R, 9)
    c.move(7, 'mouse', -300, 0, 16)
    expect(c.target()![0]).toBeCloseTo(MALLET_R, 9)
    const [bx, by] = worldToScreen(desktop, 1.4, 0)
    c.move(7, 'mouse', bx, by, 32)
    expect(c.target()![0]).toBeCloseTo(1 - MALLET_R, 9)
    expect(c.target()![1]).toBeCloseTo(MALLET_R, 9)
  })
})

describe('safe-area insets (a Face ID iPhone)', () => {
  const faceId = { top: 47, right: 0, bottom: 34, left: 0 }
  test('portrait: the table starts below the HUD, which sits at max(8, inset top) and is HUD_H tall', () => {
    const l = fitLayout(390, 844, true, faceId)
    expect(l.y).toBeGreaterThanOrEqual(Math.max(8, faceId.top) + HUD_H)
    // The thumb strip stays above the home indicator.
    expect(844 - faceId.bottom - (l.y + l.scale * 2)).toBeGreaterThanOrEqual(100)
    // Without insets nothing moves from the old layout.
    expect(fitLayout(390, 844, true, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual(portrait)
  })
  test('landscape: the table clears the notch on the left, the strip is inside the inset, the right inset is kept', () => {
    const notch = { top: 0, right: 59, bottom: 21, left: 59 }
    const l = fitLayout(844, 390, true, notch)
    expect(l.landscape).toBe(true)
    expect(l.x).toBeGreaterThanOrEqual(notch.left + 80)
    expect(l.x + l.scale * 2).toBeLessThanOrEqual(844 - notch.right)
    expect(l.y + l.scale).toBeLessThanOrEqual(390 - notch.bottom)
    expect(l.edgeGuard).toBe(notch.left + EDGE_GUARD)
  })
  test('a landscape touch that starts in the edge guard (Safari swipe back) is not claimed; one past it is', () => {
    const l = fitLayout(844, 390, true, { top: 0, right: 0, bottom: 0, left: 59 })
    const c = new MalletControl(l)
    c.reset(0.5, 0.3)
    expect(c.down(1, 'touch', 10, 200, 0)).toBe(false)
    expect(c.active(1)).toBe(false)
    expect(c.down(2, 'touch', 59 + EDGE_GUARD + 1, 200, 1)).toBe(true)
    // Portrait and a mouse have no guard.
    const p = new MalletControl(fitLayout(390, 844, true))
    expect(p.down(3, 'touch', 2, 700, 0)).toBe(true)
  })
})
