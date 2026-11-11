import { describe, expect, test } from 'bun:test'
import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { decodePuckInput } from '@duelwise/core/src/games/puck/input'
import { NO_INSETS } from './input'
import { CENTRE_DEAD_PX, TwoHands, fitLocalLayout, turnPoint } from './two-hands'

const layout = fitLocalLayout(390, 844, NO_INSETS)
const centreY = layout.y + layout.scale
const midX = layout.x + layout.scale / 2
const OFF = 30
const hands = () => new TwoHands(layout, OFF)

describe('fitLocalLayout', () => {
  test('is always a portrait table that fits the screen, even on a wide window', () => {
    for (const [w, h] of [[390, 844], [360, 780], [1440, 900], [844, 390]] as const) {
      const l = fitLocalLayout(w, h, NO_INSETS)
      expect(l.landscape).toBe(false)
      expect(l.x).toBeGreaterThanOrEqual(0)
      expect(l.x + l.scale).toBeLessThanOrEqual(w)
      expect(l.y).toBeGreaterThan(0)
      expect(l.y + l.scale * 2).toBeLessThanOrEqual(h)
    }
  })
})

describe('claiming a half', () => {
  test('the bottom half belongs to seat 0, the top half to seat 1, the centre line to nobody', () => {
    const h = hands()
    expect(h.down(1, 'touch', midX, centreY + 100)).toBe(0)
    expect(h.down(2, 'touch', midX, centreY - 100)).toBe(1)
    const g = hands()
    expect(g.down(1, 'touch', midX, centreY + CENTRE_DEAD_PX - 1)).toBeNull()
    expect(g.down(2, 'touch', midX, centreY - CENTRE_DEAD_PX + 1)).toBeNull()
    expect(g.down(3, 'touch', midX, centreY + CENTRE_DEAD_PX + 1)).toBe(0)
    expect(g.down(4, 'touch', midX, centreY - CENTRE_DEAD_PX - 1)).toBe(1)
  })

  test('two pointers move two mallets independently', () => {
    const h = hands()
    h.down(1, 'touch', midX, centreY + 150)
    h.down(2, 'touch', midX, centreY - 150)
    h.takeCode(0)
    h.takeCode(1)
    h.move(1, midX + 60, centreY + 150)
    expect(h.takeCode(1)).toBe(NO_INPUT)
    expect(h.takeCode(0)).not.toBe(NO_INPUT)
    h.move(2, midX - 40, centreY - 150)
    expect(h.takeCode(0)).toBe(NO_INPUT)
    expect(h.takeCode(1)).not.toBe(NO_INPUT)
  })

  test('a third finger and a second finger in an owned half are ignored', () => {
    const h = hands()
    expect(h.down(1, 'touch', midX, centreY + 150)).toBe(0)
    expect(h.down(2, 'touch', midX, centreY + 250)).toBeNull()
    expect(h.down(3, 'touch', midX, centreY - 150)).toBe(1)
    expect(h.down(4, 'touch', midX, centreY - 250)).toBeNull()
    expect(h.move(2, midX + 80, centreY + 250)).toBeNull()
    expect(h.move(4, midX + 80, centreY - 250)).toBeNull()
  })

  test('lifting one finger releases only that seat', () => {
    const h = hands()
    h.down(1, 'touch', midX, centreY + 150)
    h.down(2, 'touch', midX, centreY - 150)
    expect(h.up(1)).toBe(0)
    expect(h.move(1, midX + 10, centreY + 150)).toBeNull()
    expect(h.move(2, midX + 10, centreY - 150)).toBe(1)
    // The freed half can be claimed again by a new finger.
    expect(h.down(7, 'touch', midX, centreY + 160)).toBe(0)
  })

  test('cancelling all pointers frees both seats', () => {
    const h = hands()
    h.down(1, 'touch', midX, centreY + 150)
    h.down(2, 'touch', midX, centreY - 150)
    h.cancelAll()
    expect(h.move(1, midX, centreY + 140)).toBeNull()
    expect(h.down(5, 'touch', midX, centreY - 150)).toBe(1)
  })
})

describe('the turned view', () => {
  test("seat 1's touch at p gives the same cell code as seat 0's touch at p turned 180 degrees", () => {
    for (const [dx, dy] of [[0, 120], [70, 200], [-90, 60], [30, 300]] as const) {
      const bottom = hands()
      const top = hands()
      const px = midX + dx
      const py = centreY + dy
      const [tx, ty] = turnPoint(layout, px, py)
      expect(top.down(2, 'touch', tx, ty)).toBe(1)
      expect(bottom.down(1, 'touch', px, py)).toBe(0)
      const a = bottom.takeCode(0)
      const b = top.takeCode(1)
      expect(a).not.toBe(NO_INPUT)
      expect(b).toBe(a)
    }
  })

  test('the mallet sits ahead of the finger, toward the other end', () => {
    const bottom = hands()
    const top = hands()
    const py = centreY + 200
    bottom.down(1, 'touch', midX, py)
    const [tx, ty] = turnPoint(layout, midX, py)
    top.down(2, 'touch', tx, ty)
    const own = decodePuckInput(bottom.takeCode(0))!
    const noOffset = new TwoHands(layout, 0)
    noOffset.down(1, 'touch', midX, py)
    const flat = decodePuckInput(noOffset.takeCode(0))!
    // Seat 0's own view has y growing toward the centre line, which is up the screen.
    expect(own.ty).toBeGreaterThan(flat.ty)
    expect(decodePuckInput(top.takeCode(1))!.ty).toBe(own.ty)
  })

  test('a finger dragged across the centre line stays with its seat and clamps at the line', () => {
    const h = hands()
    h.down(1, 'touch', midX, centreY + 100)
    h.down(2, 'touch', midX, centreY - 100)
    h.takeCode(0)
    h.takeCode(1)
    h.move(1, midX, centreY - 200)
    h.move(2, midX, centreY + 200)
    const c0 = decodePuckInput(h.takeCode(0))!
    const c1 = decodePuckInput(h.takeCode(1))!
    expect(c0.ty).toBe(c1.ty)
    expect(h.target(0)[1]).toBeLessThan(1)
    expect(h.target(0)[1]).toBeGreaterThan(0.9)
    // Each finger still owns its seat after crossing.
    expect(h.move(1, midX, centreY + 100)).toBe(0)
    expect(h.move(2, midX, centreY - 100)).toBe(1)
  })

  test('a finger far off the table clamps to the walls', () => {
    const h = hands()
    h.down(1, 'touch', midX, centreY + 100)
    h.move(1, -500, centreY + 100)
    const [x] = h.target(0)
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(0.2)
  })
})

describe('mouse and keys (a desktop)', () => {
  test('the mouse steers seat 0 anywhere on screen, with no offset and no claim', () => {
    const h = hands()
    expect(h.down(9, 'mouse', midX, centreY - 80)).toBe(0)
    h.takeCode(0)
    expect(h.move(9, midX, centreY + 100)).toBe(0)
    const code = h.takeCode(0)
    expect(code).not.toBe(NO_INPUT)
    // Touch pointers can still claim the top half beside the mouse.
    expect(h.down(2, 'touch', midX, centreY - 100)).toBe(1)
  })

  test('arrow nudges move seat 1 along the screen and clamp', () => {
    const h = hands()
    h.reset(1, 0.5, 0.3)
    const before = h.target(1)[0]
    h.nudgeScreen(1, -20, 0)
    // Screen left is the turned seat's own right, so the own-view x grows.
    expect(h.target(1)[0]).toBeGreaterThan(before)
    expect(h.takeCode(1)).not.toBe(NO_INPUT)
    for (let i = 0; i < 100; i++) h.nudgeScreen(1, 0, -50)
    expect(h.target(1)[1]).toBeLessThan(1)
  })
})
