import {
  BoxGeometry, BufferAttribute, CanvasTexture, Color, DoubleSide, Group, HemisphereLight, InstancedMesh, Material, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PlaneGeometry, PointLight, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader, type BufferGeometry,
} from 'three'
import type { MapData } from '@duelwise/core/src/games/arena/map.ts'
import { UNIT } from './camera'

// The Coldstore map as meshes, built from the same box list the sim collides with (MapData.boxes:
// the map JSON boxes followed by the four outer walls), so what you see is exactly what blocks you.
// One mesh per box, tagged with userData.boxIndex. Set dressing (floor, ceiling, strip lights, the
// warm door at each end) sits around the boxes and never changes collision.

const BASE = '/assets/arena/polyhaven'
/** Texture tile size in metres. */
const TILE = 2

export type SurfaceKind = 'wall' | 'cover' | 'outer'

export interface MapMaterials {
  wall: Material
  cover: Material
  outer: Material
  floor: Material
  ceiling: Material
}

export interface BoxSpec {
  index: number
  kind: SurfaceKind
  /** Sim units. */
  min: [number, number, number]
  max: [number, number, number]
}

/** Every collision box of the map with its surface kind (JSON kinds, then the four outer walls). */
export function boxSpecs(map: MapData): BoxSpec[] {
  const out: BoxSpec[] = []
  const jsonCount = map.json.boxes.length
  for (let i = 0; i < map.boxCount; i++) {
    const o = i * 6
    const b = map.boxes
    const kind: SurfaceKind = i >= jsonCount ? 'outer' : map.json.boxes[i]!.kind === 'cover' ? 'cover' : 'wall'
    out.push({ index: i, kind, min: [b[o]!, b[o + 1]!, b[o + 2]!], max: [b[o + 3]!, b[o + 4]!, b[o + 5]!] })
  }
  return out
}

/**
 * A box whose UVs are in tile units (metres / TILE) on every face, so a texture keeps one scale on a
 * thin pillar and on a long wall alike. Sizes in metres.
 */
export function tiledBox(w: number, h: number, d: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d)
  const uv = g.getAttribute('uv') as BufferAttribute
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z, four vertices each.
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
  for (let f = 0; f < 6; f++) {
    const [u, v] = dims[f]!
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k
      uv.setXY(i, uv.getX(i) * (u / TILE), uv.getY(i) * (v / TILE))
    }
  }
  uv.needsUpdate = true
  return g
}

function plain(color: number, roughness = 0.9, metalness = 0): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness })
}

/** Flat colour materials: the fallback while textures load and the whole look in unit tests. */
export function plainMaterials(): MapMaterials {
  return { wall: plain(0x8d98a3), cover: plain(0x6c7580, 0.6, 0.4), outer: plain(0x7d8791), floor: plain(0x5b5f63), ceiling: plain(0x2b3036) }
}

function loadTex(loader: TextureLoader, url: string, srgb: boolean, repeat: [number, number] | null): Promise<Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (t) => {
        if (srgb) t.colorSpace = SRGBColorSpace
        t.wrapS = t.wrapT = RepeatWrapping
        if (repeat) t.repeat.set(repeat[0], repeat[1])
        t.anisotropy = 8
        resolve(t)
      },
      undefined,
      () => reject(new Error(`texture failed: ${url}`)),
    )
  })
}

async function pbr(loader: TextureLoader, name: string, opts: { repeat?: [number, number]; color?: number; metalness?: number; normalScale?: number }): Promise<MeshStandardMaterial> {
  const rep = opts.repeat ?? null
  const [map, normalMap, roughnessMap] = await Promise.all([
    loadTex(loader, `${BASE}/${name}/${name}_diff_1k.jpg`, true, rep),
    loadTex(loader, `${BASE}/${name}/${name}_nor_gl_1k.jpg`, false, rep),
    loadTex(loader, `${BASE}/${name}/${name}_rough_1k.jpg`, false, rep),
  ])
  const m = new MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 1, metalness: opts.metalness ?? 0, color: opts.color ?? 0xffffff })
  m.normalScale.set(opts.normalScale ?? 1, opts.normalScale ?? 1)
  return m
}

/** The Poly Haven (CC0) surfaces: corrugated iron walls, metal plate cover, hangar concrete floor. */
export async function loadMapMaterials(): Promise<MapMaterials> {
  const loader = new TextureLoader()
  const [wall, cover, floor, outer] = await Promise.all([
    pbr(loader, 'corrugated_iron_02', { color: 0xc7ced6, metalness: 0.35 }),
    pbr(loader, 'metal_plate_02', { color: 0xb6c0c9, metalness: 0.55 }),
    pbr(loader, 'hangar_concrete_floor', { color: 0xd0d0d0 }),
    pbr(loader, 'corrugated_iron_02', { color: 0x9aa4ae, metalness: 0.35 }),
  ])
  const ceiling = new MeshStandardMaterial({ color: 0x66717a, roughness: 0.85, metalness: 0.2, emissive: 0x293039, emissiveIntensity: 0.65 })
  return { wall, cover, outer, floor, ceiling }
}

export interface MapScene {
  group: Group
  /** Box meshes by sim box index. */
  boxes: Mesh[]
  /** Everything animated or tunable by the renderer. */
  lights: PointLight[]
  /** Swap in the textured materials once they have loaded. */
  applyMaterials(m: MapMaterials): void
  dispose(): void
}

/** Builds the map. Materials may be flat; applyMaterials swaps them later. */
export function buildMap(map: MapData, mats: MapMaterials = plainMaterials()): MapScene {
  const group = new Group()
  group.name = 'coldstore-map'
  const boxes: Mesh[] = []
  const kinds: SurfaceKind[] = []
  for (const s of boxSpecs(map)) {
    const w = (s.max[0] - s.min[0]) * UNIT
    const h = (s.max[2] - s.min[2]) * UNIT
    const d = (s.max[1] - s.min[1]) * UNIT
    const mesh = new Mesh(tiledBox(w, h, d), mats[s.kind])
    // Sim (x, y, z) to scene (x, z, -y): the box centre, with the sim y extent becoming scene z.
    mesh.position.set(((s.min[0] + s.max[0]) / 2) * UNIT, ((s.min[2] + s.max[2]) / 2) * UNIT, (-(s.min[1] + s.max[1]) / 2) * UNIT)
    mesh.castShadow = s.kind !== 'outer'
    mesh.receiveShadow = true
    mesh.userData.boxIndex = s.index
    mesh.name = `box-${s.index}-${s.kind}`
    group.add(mesh)
    boxes.push(mesh)
    kinds.push(s.kind)
  }

  const { x0, y0, x1, y1 } = map.bounds
  const wx = (x1 - x0) * UNIT
  const wz = (y1 - y0) * UNIT
  const cx = ((x0 + x1) / 2) * UNIT
  const cz = (-(y0 + y1) / 2) * UNIT
  const ceilH = map.wallHeight * UNIT

  const floorGeo = new PlaneGeometry(wx, wz)
  const fuv = floorGeo.getAttribute('uv') as BufferAttribute
  for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fuv.getX(i) * (wx / (TILE * 1.5)), fuv.getY(i) * (wz / (TILE * 1.5)))
  const floor = new Mesh(floorGeo, mats.floor)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(cx, 0, cz)
  floor.receiveShadow = true
  floor.name = 'floor'
  group.add(floor)

  const ceilGeo = new PlaneGeometry(wx, wz)
  const ceil = new Mesh(ceilGeo, mats.ceiling)
  ceil.rotation.x = Math.PI / 2
  ceil.position.set(cx, ceilH, cz)
  ceil.name = 'ceiling'
  group.add(ceil)

  const lights: PointLight[] = []
  const disposables: { dispose(): void }[] = [floorGeo, ceilGeo]

  // Strip lights: long emissive bars in three rows under the ceiling, a point light over every second one.
  const stripMat = new MeshBasicMaterial({ color: new Color(0xdbeaff), toneMapped: false })
  const stripGeo = new BoxGeometry(2.2, 0.06, 0.18)
  disposables.push(stripMat, stripGeo)
  const rows = [-0.3, 0, 0.3]
  const nCols = Math.max(2, Math.round(wx / 6))
  const strips = new InstancedMesh(stripGeo, stripMat, rows.length * nCols)
  const m4 = new Matrix4()
  let n = 0
  for (const r of rows) {
    for (let c = 0; c < nCols; c++) {
      const px = x0 * UNIT + ((c + 0.5) / nCols) * wx
      const pz = cz + r * wz
      m4.makeTranslation(px, ceilH - 0.12, pz)
      strips.setMatrixAt(n++, m4)
      if (c % 2 === 0 && r === 0) {
        const l = new PointLight(0xcfe3ff, 60, 18, 1.4)
        l.position.set(px, ceilH - 0.5, pz)
        group.add(l)
        lights.push(l)
      }
    }
  }
  group.add(strips)

  // A warm door at each end of the map, at the spawn lane, so a body reads as a dark shape against orange.
  const doorMat = new MeshBasicMaterial({ color: new Color(0xff9a3c), toneMapped: false, side: DoubleSide })
  const doorGeo = new PlaneGeometry(1.5, 2.7)
  const frameMat = new MeshBasicMaterial({ color: 0x15171a })
  const frameGeo = new PlaneGeometry(1.8, 3.0)
  disposables.push(doorMat, doorGeo, frameMat, frameGeo)
  for (const side of [-1, 1]) {
    const x = (side < 0 ? x0 : x1) * UNIT - side * 0.02
    const frame = new Mesh(frameGeo, frameMat)
    frame.position.set(x - side * 0.005, 1.5, cz)
    frame.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2
    const door = new Mesh(doorGeo, doorMat)
    door.position.set(x - side * 0.012, 1.35, cz)
    door.rotation.y = frame.rotation.y
    group.add(frame, door)
    const glow = new PointLight(0xff8a2a, 34, 20, 1.6)
    glow.position.set(x - side * 1.4, 1.6, cz)
    group.add(glow)
    lights.push(glow)
  }

  const hemi = new HemisphereLight(0xb4c8e0, 0x3a3128, 1.1)
  group.add(hemi)

  const applyMaterials = (m: MapMaterials): void => {
    for (let i = 0; i < boxes.length; i++) boxes[i]!.material = m[kinds[i]!]
    floor.material = m.floor
    ceil.material = m.ceiling
  }
  const dispose = (): void => {
    for (const b of boxes) b.geometry.dispose()
    for (const d of disposables) d.dispose()
    strips.dispose()
  }
  return { group, boxes, lights, applyMaterials, dispose }
}

/** A box's bounds in sim units, recovered from its mesh (used by the dev view to prove the mesh matches the sim). */
export function simBoundsOfMesh(mesh: Mesh): { min: [number, number, number]; max: [number, number, number] } {
  const g = mesh.geometry as BoxGeometry
  const p = g.parameters
  const hx = p.width / 2
  const hy = p.height / 2
  const hz = p.depth / 2
  const c = mesh.position
  return {
    min: [(c.x - hx) / UNIT, (-c.z - hz) / UNIT, (c.y - hy) / UNIT],
    max: [(c.x + hx) / UNIT, (-c.z + hz) / UNIT, (c.y + hy) / UNIT],
  }
}

/** A small round blob texture for decals and glows. */
export function radialTexture(inner: string, outer: string, size = 64): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grd.addColorStop(0, inner)
  grd.addColorStop(1, outer)
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}
