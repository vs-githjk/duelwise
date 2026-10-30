import { Box3, Group, Mesh, Object3D, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { MapData } from '@duelwise/core/src/games/arena/map.ts'
import { boxSpecs, type BoxSpec } from './map-mesh'
import { UNIT } from './camera'

// Coldstore set dressing from the Poly Haven (CC0) props: worn metal racks, plastic crates, barrels, the
// roller shutter door and the fluorescent fixtures. Props never change collision, so every placement
// sits flush on a collision face and sticks out of it by no more than PROTRUDE_MAX (the player hull's
// half width, 16 units): the camera cannot get inside a prop that the sim lets it walk into.

const BASE = '/assets/arena/polyhaven'
/** Hull half width in sim units (movement.ts HULL_HALF): the most a prop may stick out of a collision face. */
export const PROTRUDE_MAX = 16
/** Triangles of one copy of each prop (from the glTF index counts), and the most the props of one map may add. */
export const PROP_TRIANGLES: Record<PropKind, number> = { rack: 6372, crate: 18320, barrel: 1473, door: 552, fixture: 1496 }
export const TRIANGLE_BUDGET = 120_000

export type PropKind = 'rack' | 'crate' | 'barrel' | 'door' | 'fixture'

export interface PropPlacement {
  kind: PropKind
  /** Sim units, on the floor (z is the base of the prop, or the hang height for a fixture). */
  x: number
  y: number
  z: number
  /** Rotation about the vertical axis, radians, in the scene's sense (0 faces scene +z, which is sim -y). */
  yaw: number
  /** Uniform scale, plus a depth squash for flat things (racks, doors). */
  scale: number
  depth: number
  /** The collision box this prop stands against (-1 for ceiling fixtures). */
  host: number
  /** How far the prop sticks out of the host's face, sim units. */
  protrude: number
}

// Natural sizes in metres, measured from the glTF accessors (see docs/third-party/arena-assets.md).
const SIZE: Record<Exclude<PropKind, 'fixture'>, { w: number; h: number; d: number }> = {
  rack: { w: 0.91, h: 1.9, d: 0.6 },
  crate: { w: 0.3, h: 0.264, d: 0.408 },
  barrel: { w: 0.634, h: 0.93, d: 0.638 },
  door: { w: 1.08, h: 2.4, d: 0.3 },
}

const M = 1 / UNIT // sim units per metre

/**
 * Where every prop goes, from the map's own boxes (pure: no GL). A face is described by the side it looks to:
 * `side` +x, -x, +y, -y in sim axes. Props are centred ON the face line, so half of each is inside the opaque
 * box and the visible half sticks out by at most half its depth.
 */
export function propPlacements(map: MapData): PropPlacement[] {
  const out: PropPlacement[] = []
  const specs = boxSpecs(map)
  // Scene yaw for a prop whose front should face +x, -x, +y, -y (sim): scene x = sim x, scene z = -sim y.
  const FACE_YAW: Record<string, number> = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+y': Math.PI, '-y': 0 }

  const alongFace = (s: BoxSpec, side: '+x' | '-x' | '+y' | '-y', kind: Exclude<PropKind, 'fixture'>, step: number, count: number, scale: number, depthScale: number, z: number): void => {
    const horizontal = side === '+y' || side === '-y' // the face runs along x
    const lo = horizontal ? s.min[0] : s.min[1]
    const hi = horizontal ? s.max[0] : s.max[1]
    const faceAt = side === '+x' ? s.max[0] : side === '-x' ? s.min[0] : side === '+y' ? s.max[1] : s.min[1]
    const mid = (lo + hi) / 2
    const d = SIZE[kind].d * depthScale * scale * M
    for (let i = 0; i < count; i++) {
      const t = mid + (i - (count - 1) / 2) * step
      out.push({
        kind, x: horizontal ? t : faceAt, y: horizontal ? faceAt : t, z, yaw: FACE_YAW[side]!, scale, depth: depthScale, host: s.index, protrude: d / 2,
      })
    }
  }

  let coverNo = 0
  for (const s of specs) {
    const sx = s.max[0] - s.min[0]
    const sy = s.max[1] - s.min[1]
    if (s.kind === 'cover') {
      // Low cover: a crate on one long face of every other box (the crate model is 18k triangles, see TRIANGLE_BUDGET) and a barrel at a corner of the other.
      const crate = 1.5
      if (coverNo++ % 2 === 0) alongFace(s, '-y', 'crate', 0, 1, crate, 1, s.min[2])
      const b = 0.55
      const corner = s.max[0] - SIZE.barrel.w * b * M * 0.6
      const faceAt = s.max[1]
      out.push({ kind: 'barrel', x: corner, y: faceAt, z: s.min[2], yaw: 0, scale: b, depth: 1, host: s.index, protrude: (SIZE.barrel.d * b * M) / 2 })
    } else if (s.kind === 'wall' && Math.max(sx, sy) >= 150) {
      // The long walls hold racks on one long face, flattened to a shelf's depth.
      const w = SIZE.rack.w * M
      const run = Math.max(sx, sy)
      const count = Math.max(1, Math.min(3, Math.floor(run / (w * 1.05))))
      const sides = sy >= sx ? (['+x', '-x'] as const) : (['+y', '-y'] as const)
      // One face per wall: the rack model is 6.4k triangles, see TRIANGLE_BUDGET.
      alongFace(s, sides[0], 'rack', w * 1.05, count, 1, 0.5, s.min[2])
    } else if (s.kind === 'wall') {
      // The short pillars get a barrel against the foot of each long face.
      const b = 0.6
      const sides = sy >= sx ? (['+x', '-x'] as const) : (['+y', '-y'] as const)
      for (const side of sides) alongFace(s, side, 'barrel', 0, 1, b, 1, s.min[2])
    } else if (s.kind === 'outer') {
      // The two end walls (they face along x and are the tall ones) carry roller shutter doors beside the warm light.
      const faceAt = s.min[0] > map.bounds.x1 - 1 ? s.min[0] : s.max[0] < map.bounds.x0 + 1 ? s.max[0] : null
      if (faceAt === null) continue
      const east = faceAt > 0
      for (const dy of [-1, 1]) {
        out.push({
          kind: 'door', x: faceAt, y: dy * 130, z: 0, yaw: east ? -Math.PI / 2 : Math.PI / 2, scale: 1.3, depth: 0.6, host: s.index, protrude: (SIZE.door.d * 0.6 * 1.3 * M) / 2,
        })
      }
    }
  }
  return out
}

export interface PropKit {
  templates: Partial<Record<PropKind, Object3D>>
}

const FILES: Record<PropKind, { id: string; node?: string }> = {
  rack: { id: 'worn_metal_rack' },
  crate: { id: 'plastic_crate_01' },
  barrel: { id: 'barrel_03' },
  door: { id: 'rollershutter_door' },
  fixture: { id: 'mounted_fluorescent_lights', node: 'mounted_fluorescent_lights_a' },
}

/** Loads the props. A prop that fails to load is left out (the map is complete without props). */
export async function loadPropKit(): Promise<PropKit> {
  const loader = new GLTFLoader()
  const templates: PropKit['templates'] = {}
  await Promise.all(
    (Object.keys(FILES) as PropKind[]).map(async (kind) => {
      const f = FILES[kind]
      try {
        const gltf = await loader.loadAsync(`${BASE}/${f.id}/${f.id}.gltf`)
        const root: Object3D = f.node ? (gltf.scene.getObjectByName(f.node) ?? gltf.scene) : gltf.scene
        // Re-centre: base on y = 0, centred on x and z, so a placement is the prop's footprint centre on the floor.
        const box = new Box3().setFromObject(root)
        const c = box.getCenter(new Vector3())
        const holder = new Group()
        root.position.set(-c.x, -box.min.y, -c.z)
        holder.add(root)
        holder.traverse((o) => {
          if (o instanceof Mesh) {
            o.castShadow = kind !== 'fixture'
            o.receiveShadow = true
          }
        })
        templates[kind] = holder
      } catch (e) {
        console.warn(`arena: prop ${f.id} did not load`, e)
      }
    }),
  )
  return { templates }
}

/** Clones the placements into a group of the scene (sim to scene: x, z, -y). */
export function buildProps(placements: readonly PropPlacement[], kit: PropKit): Group {
  const g = new Group()
  g.name = 'coldstore-props'
  for (const p of placements) {
    const t = kit.templates[p.kind]
    if (!t) continue
    const o = t.clone(true)
    o.position.set(p.x * UNIT, p.z * UNIT, -p.y * UNIT)
    o.rotation.y = p.yaw
    o.scale.set(p.scale, p.scale, p.scale * p.depth)
    g.add(o)
  }
  return g
}

/** Hang points of the ceiling fixtures: the two outer rows of the strip grid, between the strips (sim units). */
export function fixturePlacements(map: MapData): PropPlacement[] {
  const { x0, y0, x1, y1 } = map.bounds
  const wx = (x1 - x0) * UNIT
  const nCols = Math.max(2, Math.round(wx / 6))
  const out: PropPlacement[] = []
  // Between the emissive strips (which sit at the middle of each column), in the two outer rows.
  for (const r of [-0.3, 0.3]) {
    for (let c = 1; c < nCols; c++) {
      out.push({
        kind: 'fixture', x: x0 + (c / nCols) * (x1 - x0), y: (y0 + y1) / 2 - r * (y1 - y0), z: map.wallHeight - 3, yaw: 0, scale: 2, depth: 1, host: -1, protrude: 0,
      })
    }
  }
  return out
}
