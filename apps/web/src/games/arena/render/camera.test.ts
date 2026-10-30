import { describe, expect, test } from 'bun:test'
import { makePlayer } from '@duelwise/core/src/games/arena/state.ts'
import { cameraYaw, easedEye, lerpAngleUnits, modelYaw, poseFor, toScene, UNIT, unitsToRad, VFOV } from './camera'

describe('arena camera', () => {
  test('lerpAngleUnits takes the short way round the 8192 wrap', () => {
    expect(lerpAngleUnits(8100, 100, 0.5)).toBeCloseTo(8196, 5)
    expect(lerpAngleUnits(100, 8100, 0.5)).toBeCloseTo(4, 5)
    expect(lerpAngleUnits(0, 4096, 0.25)).toBeCloseTo(1024, 5)
  })

  test('sim yaw 0 looks along +x in the scene: camera forward is (1, 0, 0)', () => {
    const yaw = cameraYaw(0)
    // A camera at rotation.y = yaw looks along (-sin yaw, 0, -cos yaw).
    expect(-Math.sin(yaw)).toBeCloseTo(1, 9)
    expect(-Math.cos(yaw)).toBeCloseTo(0, 9)
    // A quarter turn left (sim +y) is scene -z.
    const q = cameraYaw(2048)
    expect(-Math.sin(q)).toBeCloseTo(0, 9)
    expect(-Math.cos(q)).toBeCloseTo(-1, 9)
  })

  test('a model facing the same yaw points the same way (model front is +z)', () => {
    for (const u of [0, 1000, 2048, 5000]) {
      const m = modelYaw(u)
      const fx = Math.sin(m)
      const fz = Math.cos(m)
      expect(fx).toBeCloseTo(Math.cos(unitsToRad(u)), 9)
      expect(fz).toBeCloseTo(-Math.sin(unitsToRad(u)), 9)
    }
  })

  test('toScene maps z up to y up and y to -z, in metres', () => {
    expect(toScene(100, 50, 10)).toEqual([100 * UNIT, 10 * UNIT, -50 * UNIT])
  })

  test('poseFor blends position and puts the eye at the eased height, punch included', () => {
    const a = makePlayer()
    const b = makePlayer()
    a.x = 0; b.x = 10; b.punchPitch = 100; b.pitch = 20
    const p = poseFor(a, b, 0.5, 64)
    expect(p.x).toBeCloseTo(5 * UNIT, 9)
    expect(p.y).toBeCloseTo(64 * UNIT, 9)
    expect(p.pitch).toBeCloseTo(unitsToRad(60), 9)
  })

  test('the player view follows the mouse: the sim angle plus the turn the sim has not taken yet, clamped to the sim pitch limit', () => {
    const a = makePlayer()
    const b = makePlayer()
    a.yaw = 100; b.yaw = 200; b.pitch = 1800; b.punchYaw = 8
    const p = poseFor(a, b, 0.5, 64, { yaw: 40, pitch: 500 })
    expect(p.yaw).toBeCloseTo(cameraYaw(244), 9)
    expect(p.pitch).toBeCloseTo(unitsToRad(1900), 9)
    const same = poseFor(a, b, 0.5, 64, { yaw: 0, pitch: 0 })
    expect(same.yaw).toBeCloseTo(cameraYaw(204), 9)
    // Without a pending turn (an opponent's or a replayed view) the pose still blends between the two states.
    expect(poseFor(a, b, 0.5, 64).yaw).toBeCloseTo(cameraYaw(154), 9)
  })

  test('eye height eases between 64 and 46', () => {
    expect(easedEye(0)).toBe(64)
    expect(easedEye(1)).toBe(46)
    expect(easedEye(0.5)).toBe(55)
  })

  test('the field of view matches the sim sight cone (106 degrees horizontal at 16:9)', () => {
    const h = 2 * Math.atan(Math.tan((VFOV * Math.PI) / 360) * (16 / 9)) * (180 / Math.PI)
    expect(h).toBeGreaterThan(105.9)
    expect(h).toBeLessThan(106.7)
  })
})
