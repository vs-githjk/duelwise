import { describe, expect, test } from 'bun:test'
import { MAP_LIST } from '@duelwise/core/src/games/arena/map.ts'
import { UNIT } from './camera'
import { boxSpecs, buildMap, simBoundsOfMesh } from './map-mesh'

describe('arena map meshes', () => {
  for (const map of MAP_LIST) {
    test(`${map.id}: one mesh per sim box, with the sim's exact bounds`, () => {
      const scene = buildMap(map)
      expect(scene.boxes.length).toBe(map.boxCount)
      expect(map.boxCount).toBe(map.json.boxes.length + 4)
      for (let i = 0; i < map.boxCount; i++) {
        const o = i * 6
        const b = simBoundsOfMesh(scene.boxes[i]!)
        const want = [map.boxes[o]!, map.boxes[o + 1]!, map.boxes[o + 2]!, map.boxes[o + 3]!, map.boxes[o + 4]!, map.boxes[o + 5]!]
        const got = [...b.min, ...b.max]
        for (let k = 0; k < 6; k++) expect(got[k]).toBeCloseTo(want[k]!, 6)
        expect(scene.boxes[i]!.userData.boxIndex).toBe(i)
      }
      scene.dispose()
    })
  }

  test('surface kinds follow the map json, outer walls last', () => {
    const map = MAP_LIST[0]!
    const specs = boxSpecs(map)
    expect(specs.slice(-4).every((s) => s.kind === 'outer')).toBe(true)
    expect(specs.filter((s) => s.kind === 'cover').length).toBe(map.json.boxes.filter((b) => b.kind === 'cover').length)
  })

  test('UVs are in tile units, so a long wall repeats the texture instead of stretching it', () => {
    const map = MAP_LIST[0]!
    const scene = buildMap(map)
    const longWall = scene.boxes[map.boxCount - 2]! // an outer wall along x
    const uv = longWall.geometry.getAttribute('uv')
    let maxU = 0
    for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i))
    expect(maxU).toBeGreaterThan(5)
    expect(UNIT).toBe(0.0254)
    scene.dispose()
  })

  test('the map has a ceiling, a floor and lights', () => {
    const scene = buildMap(MAP_LIST[0]!)
    const names = scene.group.children.map((c) => c.name)
    expect(names).toContain('floor')
    expect(names).toContain('ceiling')
    expect(scene.lights.length).toBeGreaterThanOrEqual(3)
    scene.dispose()
  })
})
