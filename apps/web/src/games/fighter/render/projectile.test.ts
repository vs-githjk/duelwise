import { expect, test } from 'bun:test'
import { CORE_RADIUS, GLOW_SIZE, TRAIL_LENGTH, TRAIL_STEP, trailPoints, travelDirection } from './projectile.ts'

test('the trail is a run of glows behind the head that fade and shrink away from it', () => {
  const pts = trailPoints()
  expect(pts.length).toBe(TRAIL_LENGTH)
  expect(pts[0]!.offset).toBeCloseTo(TRAIL_STEP, 9)
  for (let i = 1; i < pts.length; i++) {
    expect(pts[i]!.offset).toBeGreaterThan(pts[i - 1]!.offset)
    expect(pts[i]!.strength).toBeLessThan(pts[i - 1]!.strength)
  }
  expect(pts[0]!.strength).toBeLessThan(1)
  expect(pts[pts.length - 1]!.strength).toBeGreaterThan(0)
})

test('the projectile is a bright core inside a larger glow, both smaller than a torso', () => {
  expect(GLOW_SIZE).toBeGreaterThan(CORE_RADIUS * 2)
  expect(GLOW_SIZE).toBeLessThan(1.2)
  expect(TRAIL_LENGTH * TRAIL_STEP).toBeLessThan(1.5)
})

test('the trail follows the projectile velocity, not the owner facing', () => {
  // The owner can turn or be crossed after firing; the shot keeps its own heading.
  expect(travelDirection(6, -1)).toBe(1)
  expect(travelDirection(-6, 1)).toBe(-1)
  expect(travelDirection(0, -1)).toBe(-1)
})
