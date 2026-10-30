import { describe, expect, test } from 'bun:test'
import { MAP_LIST } from '@duelwise/core/src/games/arena/map.ts'
import { makePlayer } from '@duelwise/core/src/games/arena/state.ts'
import { aimDir, rayBoxes, rayHull, shotVisual } from './tracers'

const map = MAP_LIST[0]! // duel-1: pillar at x -60..60, y -100..100; outer wall at x = 700

describe('shot visuals', () => {
  test('aimDir looks along +x at yaw 0, up with positive pitch, and includes the punch', () => {
    const p = makePlayer()
    expect(aimDir(p)[0]).toBeCloseTo(1, 9)
    p.pitch = 1024
    expect(aimDir(p)[2]).toBeCloseTo(Math.sin(Math.PI / 4), 9)
    const q = makePlayer()
    q.punchYaw = 2048
    expect(aimDir(q)[1]).toBeCloseTo(1, 9)
  })

  test('rayBoxes finds the pillar face first, with its normal', () => {
    const h = rayBoxes(map, -600, 0, 64, 1, 0, 0)!
    expect(h.t).toBeCloseTo(540, 6)
    expect([h.nx, h.ny, h.nz]).toEqual([-1, 0, 0])
    expect(h.box).toBeGreaterThanOrEqual(0)
  })

  test('rayBoxes past the pillar ends on the outer wall; down hits the floor; up hits the ceiling', () => {
    const wall = rayBoxes(map, -600, 200, 64, 1, 0, 0)!
    expect(wall.t).toBeCloseTo(1300, 6)
    expect(wall.nx).toBe(-1)
    const floor = rayBoxes(map, 0, 200, 64, 0, 0, -1)!
    expect(floor.box).toBe(-1)
    expect(floor.t).toBeCloseTo(64, 6)
    const ceil = rayBoxes(map, 0, 200, 64, 0, 0, 1)!
    expect(ceil.box).toBe(-2)
    expect(ceil.t).toBeCloseTo(map.wallHeight - 64, 6)
  })

  test('rayHull hits a standing hull and misses a ray that passes over a crouching one', () => {
    const q = makePlayer()
    q.x = 100; q.y = 0; q.z = 0
    expect(rayHull(q, 0, 0, 64, 1, 0, 0)).toBeCloseTo(84, 6)
    q.crouch = 1
    expect(rayHull(q, 0, 0, 64, 1, 0, 0)).toBe(-1)
  })

  test('shotVisual ends on the opponent when in line, on the wall otherwise', () => {
    const a = makePlayer()
    a.x = -600; a.y = 200; a.z = 0
    const b = makePlayer()
    b.x = 0; b.y = 200; b.z = 0
    const hit = shotVisual(map, a, b, true, [20, 8, 6])
    expect(hit.end).toBe('player')
    b.y = -200
    const miss = shotVisual(map, a, b, false, [20, 8, 6])
    expect(miss.end).toBe('wall')
    // The wall at x = 700: a scene x of 700 * 0.0254.
    expect(miss.to.x).toBeCloseTo(700 * 0.0254, 3)
    expect(miss.from.x).toBeGreaterThan(-600 * 0.0254)
  })
})
