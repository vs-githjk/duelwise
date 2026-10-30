import { describe, expect, test } from 'bun:test'
import { makePlayer } from '@duelwise/core/src/games/arena/state.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Box3, Euler, Mesh, Object3D, PerspectiveCamera, SkinnedMesh, Vector3 } from 'three'
import { easedEye, FAR, NEAR, poseFor, toScene, VFOV } from './camera'
import { boltGlb } from './bolt-fixture'
import { PBR_SETS, VIEWMODEL_FOV, VIEWMODEL_RIFLE_SCALE, Viewmodel, viewmodelPose, WeaponModels } from './viewmodel'

const bytes = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'public', 'assets', 'arena', 'oga-rifle', 'rifle.glb'))
const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const meshes = (root: Object3D): Mesh[] => {
  const out: Mesh[] = []
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh)
  })
  return out
}
const skinnedMeshes = (root: Object3D): SkinnedMesh[] => meshes(root).filter((m) => (m as SkinnedMesh).isSkinnedMesh) as SkinnedMesh[]

/** The scene at ?pose=idle&own=N&at=-360,112,0: you at (-360, 112) facing +x, the opponent 7.6 m ahead and 2.3 m to the right. */
const AT = { x: -360, y: 112, yaw: 0 }
const OPP = { x: -60, y: 20 }
const ASPECT = 16 / 9

function worldCamera(): PerspectiveCamera {
  const me = makePlayer()
  me.x = AT.x
  me.y = AT.y
  me.yaw = AT.yaw
  const p = poseFor(me, me, 1, easedEye(0))
  const cam = new PerspectiveCamera(VFOV, ASPECT, NEAR, FAR)
  cam.rotation.order = 'YXZ'
  cam.position.set(p.x, p.y, p.z)
  cam.rotation.set(p.pitch, p.yaw, 0)
  cam.updateMatrixWorld(true)
  return cam
}

/** NDC rectangle (viewmodel camera, same eye and angles as the world camera) of the opponent's torso: hips to shoulders, shoulder wide. */
function torsoRect(): { x0: number; x1: number; y0: number; y1: number } {
  const cam = worldCamera()
  const sight = new Vector3(OPP.x - AT.x, 0, -(OPP.y - AT.y)).normalize()
  const across = sight.clone().cross(new Vector3(0, 1, 0)) // horizontal, perpendicular to the line of sight
  const xs: number[] = []
  const ys: number[] = []
  for (const z of [34, 58]) {
    for (const s of [-9, 9]) {
      const [sx, sy, sz] = toScene(OPP.x, OPP.y, z)
      const v = new Vector3(sx, sy, sz).addScaledVector(across, s * 0.0254).project(cam)
      xs.push(v.x)
      ys.push(v.y)
    }
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

const skinned = (b: ReturnType<WeaponModels['build']>, m: SkinnedMesh): Vector3[] => {
  b.group.updateMatrixWorld(true)
  m.skeleton.update()
  const out: Vector3[] = []
  for (let i = 0; i < m.geometry.attributes.position!.count; i++) {
    const v = new Vector3()
    m.getVertexPosition(i, v)
    out.push(v.applyMatrix4(m.matrixWorld))
  }
  return out
}

const GRID_W = 160
const GRID_H = 90
/** Triangles of the gun group projected to NDC, rasterised on a coarse grid: which cells does the viewmodel cover? */
function coverage(b: ReturnType<WeaponModels['build']>, cam: PerspectiveCamera): Uint8Array {
  const grid = new Uint8Array(GRID_W * GRID_H)
  b.group.updateMatrixWorld(true)
  for (const m of meshes(b.group)) {
    if (!m.visible) continue
    const sk = m as SkinnedMesh
    if (sk.isSkinnedMesh) sk.skeleton.update()
    const idx = m.geometry.index
    const n = m.geometry.attributes.position!.count
    const pts: Vector3[] = []
    for (let i = 0; i < n; i++) {
      const v = new Vector3()
      if (sk.isSkinnedMesh) sk.getVertexPosition(i, v)
      else v.fromBufferAttribute(m.geometry.attributes.position as import('three').BufferAttribute, i)
      pts.push(v.applyMatrix4(m.matrixWorld).project(cam))
    }
    const tris = idx ? idx.count / 3 : n / 3
    for (let t = 0; t < tris; t++) {
      const [a, c, d] = [0, 1, 2].map((k) => pts[idx ? idx.getX(t * 3 + k) : t * 3 + k]!) as [Vector3, Vector3, Vector3]
      const minx = Math.max(0, Math.floor(((Math.min(a.x, c.x, d.x) + 1) / 2) * GRID_W))
      const maxx = Math.min(GRID_W - 1, Math.ceil(((Math.max(a.x, c.x, d.x) + 1) / 2) * GRID_W))
      const miny = Math.max(0, Math.floor(((Math.min(a.y, c.y, d.y) + 1) / 2) * GRID_H))
      const maxy = Math.min(GRID_H - 1, Math.ceil(((Math.max(a.y, c.y, d.y) + 1) / 2) * GRID_H))
      const den = (c.y - d.y) * (a.x - d.x) + (d.x - c.x) * (a.y - d.y)
      if (Math.abs(den) < 1e-12) continue
      for (let gy = miny; gy <= maxy; gy++) {
        for (let gx = minx; gx <= maxx; gx++) {
          const x = ((gx + 0.5) / GRID_W) * 2 - 1
          const y = ((gy + 0.5) / GRID_H) * 2 - 1
          const l1 = ((c.y - d.y) * (x - d.x) + (d.x - c.x) * (y - d.y)) / den
          const l2 = ((d.y - a.y) * (x - d.x) + (a.x - d.x) * (y - d.y)) / den
          if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) grid[gy * GRID_W + gx] = 1
        }
      }
    }
  }
  return grid
}

/** Covered fraction of an NDC rectangle. */
function covered(grid: Uint8Array, r: { x0: number; x1: number; y0: number; y1: number }): number {
  let hit = 0
  let all = 0
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = ((gx + 0.5) / GRID_W) * 2 - 1
      const y = ((gy + 0.5) / GRID_H) * 2 - 1
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue
      all++
      hit += grid[gy * GRID_W + gx]!
    }
  }
  return all === 0 ? 0 : hit / all
}

/** The band to the right of the crosshair at eye height: out to 25 degrees right (tan 25 over the viewmodel half width), from 8 degrees below to 8 degrees above the eye line. */
const HALF_W = Math.tan((VIEWMODEL_FOV / 2) * (Math.PI / 180)) * ASPECT
const HALF_H = Math.tan((VIEWMODEL_FOV / 2) * (Math.PI / 180))
const BAND = { x0: 0, x1: Math.tan((25 * Math.PI) / 180) / HALF_W, y0: -Math.tan((8 * Math.PI) / 180) / HALF_H, y1: Math.tan((8 * Math.PI) / 180) / HALF_H }

function restGun(models: WeaponModels, idx: number) {
  const b = models.build(idx)
  const p = makePlayer()
  p.weapon = idx
  const vm = viewmodelPose(p, { time: 0, raise: 1 })
  b.group.position.set(...vm.pos)
  b.group.rotation.set(...vm.rot)
  b.group.scale.setScalar(idx === 0 ? 1 : VIEWMODEL_RIFLE_SCALE)
  return b
}

const rifles = async (): Promise<WeaponModels> => {
  const models = new WeaponModels()
  await models.parseRifle(buf)
  await models.parseBolt(boltGlb())
  return models
}

describe('rifle placement (T35c)', () => {
  test('nothing of the gun or the gloves covers the band right of the crosshair at eye height, out to 25 degrees', async () => {
    const models = await rifles()
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, ASPECT, 0.01, 5)
    for (const idx of [0, 1, 2]) {
      const g = coverage(restGun(models, idx), cam)
      expect(covered(g, BAND), `weapon ${idx} band coverage`).toBe(0)
    }
  })

  test('at ?pose=idle&own=1&at=-360,112,0 the opponent torso is not covered by any weapon', async () => {
    const models = await rifles()
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, ASPECT, 0.01, 5)
    const t = torsoRect()
    // The torso really is where the band test expects it: right of the crosshair, near eye height.
    expect(t.x0).toBeGreaterThan(0)
    expect(t.x1).toBeLessThan(BAND.x1)
    for (const idx of [0, 1, 2]) {
      expect(covered(coverage(restGun(models, idx), cam), t), `weapon ${idx} torso coverage`).toBe(0)
    }
  })

  test('the rifles stay in the bottom right quadrant and readable: receiver, magazine and sight on screen', async () => {
    const models = await rifles()
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, ASPECT, 0.01, 5)
    for (const idx of [1, 2]) {
      const b = restGun(models, idx)
      b.group.updateMatrixWorld(true)
      let cx = 0
      let cy = 0
      let n = 0
      for (const m of meshes(b.group)) {
        const sk = m as SkinnedMesh
        const isGlove = m.name.startsWith('Hand') || m.material === models.gloveMaterial
        // The bolt rifle's hidden scope is not drawn.
        let hidden = false
        for (let o: Object3D | null = m; o; o = o.parent) if (!o.visible) hidden = true
        if (hidden || m.name.startsWith('Cuff')) continue
        const vs = sk.isSkinnedMesh
          ? skinned(b, sk).map((v) => v.project(cam))
          : Array.from({ length: m.geometry.attributes.position!.count }, (_, i) => new Vector3().fromBufferAttribute(m.geometry.attributes.position as import('three').BufferAttribute, i).applyMatrix4(m.matrixWorld).project(cam))
        const on = vs.filter((v) => Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1).length / vs.length
        expect(on, `weapon ${idx} ${m.name} on screen`).toBeGreaterThanOrEqual(0.85)
        if (!isGlove && !m.name.startsWith('Cuff')) {
          for (const v of vs) {
            cx += v.x
            cy += v.y
            n++
          }
        }
      }
      expect(cx / n, `weapon ${idx} gun centre x`).toBeGreaterThan(0)
      expect(cy / n, `weapon ${idx} gun centre y`).toBeLessThan(0)
      // Enough of the screen for the gun to read: at least 3 percent of the grid, 1.2 percent for the slim bolt rifle (the gloves are drawn by the viewmodel, not counted here).
      const cells = coverage(b, cam).reduce((a, c) => a + c, 0)
      expect(cells / (GRID_W * GRID_H), `weapon ${idx} screen share`).toBeGreaterThan(idx === 1 ? 0.012 : 0.03)
    }
  })
})

describe('gloves (T35c)', () => {
  test('the glove is a dark charcoal PBR fabric, rough, with normal detail', async () => {
    const models = await rifles()
    const set = PBR_SETS.glove
    expect(set.id).toBe('fabric_leather_02')
    const m = models.gloveMaterial
    expect(m.roughness).toBeGreaterThanOrEqual(0.85)
    // Relative luminance of the tint (sRGB values): dark fabric, between 0.15 and 0.45 (not stone grey, not a black slab).
    const [r, g, b] = [(set.tint >> 16) & 255, (set.tint >> 8) & 255, set.tint & 255].map((c) => c / 255)
    expect(0.2126 * r! + 0.7152 * g! + 0.0722 * b!).toBeGreaterThan(0.15)
    expect(0.2126 * r! + 0.7152 * g! + 0.0722 * b!).toBeLessThan(0.45)
    expect(set.normalScale ?? 1).toBeGreaterThan(0.3)
    for (const k of ['diff', 'nor_gl']) {
      expect(() => readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'public', 'assets', 'arena', 'polyhaven', set.id, `${set.id}_${k}_1k.webp`))).not.toThrow()
    }
    // The rifle hands use that material.
    const hands = meshes(models.build(2).group).filter((x) => x.name.startsWith('Hand'))
    expect(hands.length).toBe(2)
    for (const h of hands) expect(h.material).toBe(m)
  })

  test('each rifle hand has a visible cuff band at the wrist, on the bone, and the opponent copy has none', async () => {
    const models = await rifles()
    const b = models.build(2)
    const cuffs = meshes(b.group).concat([]).length // all meshes
    const names: string[] = []
    b.group.traverse((o) => {
      if (o.name.startsWith('Cuff')) names.push(o.name)
    })
    expect(names.sort()).toEqual(['Cuff1', 'Cuff2'])
    expect(cuffs).toBeGreaterThan(4)
    const held: string[] = []
    models.build(2, false).group.traverse((o) => {
      if (o.name.startsWith('Cuff')) held.push(o.name)
    })
    expect(held).toEqual([])
    // The band is wider than the forearm it wraps and sits on screen at the rest pose.
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, ASPECT, 0.01, 5)
    const rest = restGun(models, 2)
    rest.group.updateMatrixWorld(true)
    rest.group.traverse((o) => {
      if (!o.name.startsWith('Cuff')) return
      const v = o.getWorldPosition(new Vector3()).project(cam)
      expect(Math.abs(v.x), `${o.name} x`).toBeLessThan(1)
      expect(Math.abs(v.y), `${o.name} y`).toBeLessThan(1)
    })
    // The band has a sane world size (finite, positive, under 15 cm) and overlaps its own hand mesh.
    const hands = meshes(rest.group).filter((m) => m.name.startsWith('Hand'))
    for (const n of ['1', '2']) {
      const cuff = meshes(rest.group).find((m) => m.name === `Cuff${n}`)!
      const hand = hands.find((m) => m.name === `Hand${n}`)! as SkinnedMesh
      const scale = cuff.getWorldScale(new Vector3())
      cuff.geometry.computeBoundingBox()
      const g = cuff.geometry.boundingBox!.getSize(new Vector3())
      const size = [g.x * scale.x, g.y * scale.y, g.z * scale.z]
      for (const d of size) {
        expect(Number.isFinite(d), `Cuff${n} size finite`).toBe(true)
        expect(d, `Cuff${n} size > 0`).toBeGreaterThan(0)
        expect(d, `Cuff${n} size < 0.15 m`).toBeLessThan(0.15)
      }
      const box = new Box3().setFromObject(cuff)
      const hb = new Box3().setFromPoints(skinned(rest, hand))
      expect(box.intersectsBox(hb), `Cuff${n} overlaps Hand${n}`).toBe(true)
    }
  })
})

describe('muzzle flash light (T35c)', () => {
  const stubDocument = () => {
    const g = globalThis as unknown as { document?: unknown }
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' }) }),
    }
  }

  test('the flash light sits within 2 cm of the muzzle at scale 0.6 and with the holder rotated', async () => {
    stubDocument()
    const models = await rifles()
    const vm = new Viewmodel(models)
    for (const idx of [1, 2]) {
      const p = makePlayer()
      p.weapon = idx
      p.sinceShot = 0
      // Settle the raise, then fire with the gun turned (the reload tilt and the recoil rotate the holder).
      for (let i = 0; i < 40; i++) vm.update(1 / 60, p, 99, false)
      p.reload = 20
      vm.update(1 / 60, p, 99, false)
      const gun = (vm as unknown as { gun: { muzzle: Object3D; group: Object3D } }).gun
      const muzzle = gun.muzzle.getWorldPosition(new Vector3())
      const light = vm.flashLight.getWorldPosition(new Vector3())
      expect(gun.group.scale.x).toBeCloseTo(VIEWMODEL_RIFLE_SCALE, 9)
      expect(light.distanceTo(muzzle), `weapon ${idx} light to muzzle`).toBeLessThan(0.02)
      // The holder really was rotated, so this is not the trivial case.
      const holder = (vm as unknown as { holder: Object3D }).holder
      expect(new Euler().setFromQuaternion(holder.quaternion).x).not.toBe(0)
    }
  })
})
