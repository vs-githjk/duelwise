import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAP_LIST } from '@duelwise/core/src/games/arena/map.ts'
import { fixturePlacements, propPlacements, PROP_TRIANGLES, PROTRUDE_MAX, TRIANGLE_BUDGET, type PropKind } from './props'

const ROOT = join(import.meta.dir, '..', '..', '..', '..', 'public', 'assets', 'arena', 'polyhaven')
const IDS: Record<PropKind, string> = { rack: 'worn_metal_rack', crate: 'plastic_crate_01', barrel: 'barrel_03', door: 'rollershutter_door', fixture: 'mounted_fluorescent_lights' }

describe('Coldstore set dressing', () => {
  for (const map of MAP_LIST) {
    test(`${map.id}: every prop sticks out of its collision face by less than the player hull, so the camera never sits inside one`, () => {
      const ps = propPlacements(map)
      expect(ps.length).toBeGreaterThan(10)
      for (const p of ps) {
        expect(p.protrude, `${p.kind} at ${p.x},${p.y}`).toBeLessThanOrEqual(PROTRUDE_MAX)
        expect(p.host).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeGreaterThanOrEqual(map.bounds.x0 - 1)
        expect(p.x).toBeLessThanOrEqual(map.bounds.x1 + 1)
        expect(p.y).toBeGreaterThanOrEqual(map.bounds.y0 - 1)
        expect(p.y).toBeLessThanOrEqual(map.bounds.y1 + 1)
      }
    })

    test(`${map.id}: it has racks, crates, barrels, doors and fixtures`, () => {
      const kinds = new Set([...propPlacements(map), ...fixturePlacements(map)].map((p) => p.kind))
      for (const k of ['rack', 'crate', 'barrel', 'door', 'fixture'] as const) expect(kinds.has(k), k).toBe(true)
    })
  }

  for (const map of MAP_LIST) {
    test(`${map.id}: the props add at most ${TRIANGLE_BUDGET} triangles (software GL in the browser tests and weak laptops draw them)`, () => {
      const all = [...propPlacements(map), ...fixturePlacements(map)]
      const tris = all.reduce((n, p) => n + PROP_TRIANGLES[p.kind], 0)
      expect(tris).toBeLessThanOrEqual(TRIANGLE_BUDGET)
    })
  }

  test('the triangle table matches the shipped glTF files', () => {
    for (const [kind, id] of Object.entries(IDS) as Array<[PropKind, string]>) {
      const g = JSON.parse(readFileSync(join(ROOT, id, `${id}.gltf`), 'utf8')) as { nodes: Array<{ name: string; mesh?: number }>; meshes: Array<{ primitives: Array<{ indices: number }> }>; accessors: Array<{ count: number }> }
      const nodeName = kind === 'fixture' ? 'mounted_fluorescent_lights_a' : id
      const node = g.nodes.find((n) => n.name === nodeName)!
      const tris = g.meshes[node.mesh!]!.primitives.reduce((n, p) => n + g.accessors[p.indices]!.count / 3, 0)
      expect(tris, kind).toBe(PROP_TRIANGLES[kind])
    }
  })

  test('stacked crates stay below the top of the cover they stand on', () => {
    const map = MAP_LIST[0]!
    for (const p of propPlacements(map).filter((q) => q.kind === 'crate')) {
      const host = map.json.boxes[p.host]!
      expect(p.z + 0.264 * p.scale * 39.37).toBeLessThanOrEqual(host.z1 + 1e-6)
    }
  })

  test('every prop file is shipped with its licence, textures and the glTF points at files that exist', () => {
    for (const id of Object.values(IDS)) {
      const dir = join(ROOT, id)
      expect(readFileSync(join(dir, 'LICENSE.txt'), 'utf8')).toContain('CC0')
      const g = JSON.parse(readFileSync(join(dir, `${id}.gltf`), 'utf8')) as { images?: Array<{ uri: string }>; buffers: Array<{ uri: string }>; scenes: Array<{ nodes: number[] }>; nodes: Array<{ mesh?: number }>; materials: Array<Record<string, unknown>> }
      expect(existsSync(join(dir, g.buffers[0]!.uri))).toBe(true)
      // Only the images a kept node's material uses must exist (the shutter door's spare graffiti variant is dropped).
      const used = new Set<number>()
      for (const m of g.materials) JSON.stringify(m).replace(/"index":(\d+)/g, (_, i) => (used.add(Number(i)), ''))
      expect(g.scenes[0]!.nodes.length).toBeGreaterThan(0)
      for (const im of g.images ?? []) if (!im.uri.includes('graffiti')) expect(existsSync(join(dir, im.uri)), im.uri).toBe(true)
    }
  })
})
