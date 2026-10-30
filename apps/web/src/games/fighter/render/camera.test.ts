import { expect, test } from 'bun:test'
import { MAX_SEPARATION } from '@duelwise/core/src/games/fighter/constants'
import { CameraRig, STAGE_LIMIT, VIEW_HALF, WALL_MARGIN, clampCameraX, zoomForDistance } from './camera.ts'

function zoomAfterPush(reduced: boolean): number {
  const rig = new CameraRig()
  rig.setReducedMotion(reduced)
  rig.snap(0, 400)
  for (let i = 0; i < 90; i++) rig.update(1 / 60, 0, 400, 0.08)
  return rig.currentZoom
}

test('the KO push in is skipped under reduced motion', () => {
  const base = zoomAfterPush(true)
  const rig = new CameraRig()
  rig.snap(0, 400)
  for (let i = 0; i < 90; i++) rig.update(1 / 60, 0, 400, 0)
  expect(base).toBeCloseTo(rig.currentZoom, 6)
  expect(zoomAfterPush(false)).toBeGreaterThan(base + 0.05)
})

test('the super holds the camera on the attacker for 20 frames, then releases', () => {
  const rig = new CameraRig()
  rig.snap(0, 400)
  rig.freeze(20, -300)
  expect(rig.holding).toBe(true)
  for (let i = 0; i < 18; i++) rig.update(1 / 60, 300, 400)
  expect(rig.currentX).toBeLessThan(-150)
  for (let i = 0; i < 8; i++) rig.update(1 / 60, 300, 400)
  expect(rig.holding).toBe(false)
})

test('both fighters stay on screen at every legal separation and position (R30, MAX_SEPARATION)', () => {
  const MARGIN = 40 // a fighter is 60 wide; keep at least half a body plus a little inside the frame
  let worst = Infinity
  for (let dist = 0; dist <= MAX_SEPARATION; dist += 25) {
    const zoom = zoomForDistance(dist)
    // The midpoint ranges over every place two fighters dist apart can stand inside the walls.
    const reach = 800 - dist / 2
    for (let mid = -reach; mid <= reach; mid += 25) {
      const cam = clampCameraX(mid, zoom)
      const half = VIEW_HALF / zoom
      for (const x of [mid - dist / 2, mid + dist / 2]) worst = Math.min(worst, half - Math.abs(x - cam))
    }
  }
  expect(worst).toBeGreaterThanOrEqual(MARGIN)
})

test('the camera never shows past the stage walls by more than the allowed margin', () => {
  for (const zoom of [0.86, 1, 1.15]) {
    const cam = clampCameraX(10_000, zoom)
    expect(cam + VIEW_HALF / zoom).toBeLessThanOrEqual(STAGE_LIMIT + WALL_MARGIN + 1e-9)
  }
})
