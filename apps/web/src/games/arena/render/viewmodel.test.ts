import { describe, expect, test } from 'bun:test'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons.ts'
import { makePlayer } from '@duelwise/core/src/games/arena/state.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Box3, PerspectiveCamera, SkinnedMesh, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { boltGlb } from './bolt-fixture'
import { BOLT_MUZZLE_Z, CARBINE_DEVICE_LENGTH, flashStrength, spreadDegrees, spreadOf, VIEWMODEL_FOV, VIEWMODEL_RIFLE_SCALE, Viewmodel, viewmodelPose, WeaponModels } from './viewmodel'

const bytes = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'public', 'assets', 'arena', 'oga-rifle', 'rifle.glb'))
const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const still = (weapon = 0) => {
  const p = makePlayer()
  p.weapon = weapon
  return p
}
const opts = { time: 0, raise: 1 }

describe('viewmodel pose', () => {
  test('a still weapon sits at its rest pose with no flash', () => {
    const v = viewmodelPose(still(), opts)
    expect(v.flash).toBe(0)
    expect(v.rot[0]).toBe(0)
  })

  test('a shot kicks the weapon back and up and flashes, then eases out', () => {
    const p = still(1)
    const rest = viewmodelPose(p, opts)
    p.sinceShot = 0
    const shot = viewmodelPose(p, opts)
    expect(shot.flash).toBe(1)
    expect(shot.pos[2]).toBeGreaterThan(rest.pos[2])
    expect(shot.rot[0]).toBeGreaterThan(rest.rot[0])
    p.sinceShot = 20
    const later = viewmodelPose(p, opts)
    expect(later.flash).toBe(0)
    expect(later.rot[0]).toBeLessThan(shot.rot[0] / 4)
  })

  test('reload dips the weapon most in the middle of the reload', () => {
    const p = still(1)
    const w = WEAPONS[1]!
    p.reload = w.reloadFrames
    const start = viewmodelPose(p, opts)
    p.reload = Math.round(w.reloadFrames / 2)
    const mid = viewmodelPose(p, opts)
    p.reload = 1
    const end = viewmodelPose(p, opts)
    expect(mid.pos[1]).toBeLessThan(start.pos[1] - 0.1)
    expect(end.pos[1]).toBeGreaterThan(mid.pos[1] + 0.1)
  })

  test('the raise lowers the weapon until it is fully up', () => {
    const p = still()
    const down = viewmodelPose(p, { time: 0, raise: 0 })
    const up = viewmodelPose(p, { time: 0, raise: 1 })
    expect(down.pos[1]).toBeLessThan(up.pos[1] - 0.2)
  })

  test('reduced motion shrinks the kick', () => {
    const p = still()
    p.sinceShot = 0
    const a = viewmodelPose(p, opts)
    const b = viewmodelPose(p, { ...opts, reduced: true })
    expect(b.rot[0]).toBeLessThan(a.rot[0] / 2)
  })

  test('reduced motion scales the kick to a quarter and caps the flash at 0.4', () => {
    const p = still(1)
    p.sinceShot = 0
    const a = viewmodelPose(p, opts)
    const b = viewmodelPose(p, { ...opts, reduced: true })
    expect(b.rot[0]).toBeCloseTo(a.rot[0] * 0.25, 9)
    expect(b.pos[2] - 0).toBeLessThan(a.pos[2])
    expect(a.flash).toBe(1)
    expect(flashStrength(a.flash, false)).toBe(1)
    expect(flashStrength(a.flash, true)).toBe(0.4)
    expect(flashStrength(0.2, true)).toBe(0.2)
  })
})

describe('spread (same formula as the sim)', () => {
  test('exactly zero standing still with no spray, and grows with the spray up to ten shots', () => {
    const p = still(1)
    expect(spreadOf(p)).toBe(0)
    p.recoilIdx = 5
    const five = spreadOf(p)
    p.recoilIdx = 40
    expect(five).toBeCloseTo(5 * WEAPONS[1]!.fireSpread, 12)
    expect(spreadOf(p)).toBeCloseTo(10 * WEAPONS[1]!.fireSpread, 12)
  })

  test('running adds movement spread, and a jump uses the air spread', () => {
    const p = still(1)
    p.vx = WEAPONS[1]!.maxSpeed
    expect(spreadOf(p)).toBeCloseTo(WEAPONS[1]!.moveSpread, 12)
    p.vx = 0
    p.onGround = 0
    expect(spreadOf(p)).toBeCloseTo(0.12, 12)
    expect(spreadDegrees(p)).toBeGreaterThan(6)
  })
})

describe('the Carbine combines the OGA GLB with procedural detail', () => {
  const meshes = (root: import('three').Object3D) => {
    const out: import('three').Mesh[] = []
    root.traverse((o) => {
      // The glove cuffs are small bands added at load (T35c) and the muzzle devices are code-made (JC2); the file's own meshes are the skinned ones.
      if ((o as import('three').Mesh).isMesh && !o.name.startsWith('Cuff') && !o.name.startsWith('Device') && !o.name.startsWith('Carbine')) out.push(o as import('three').Mesh)
    })
    return out
  }

  test('the Carbine keeps the skinned hands and clip, and its body is three procedural meshes on the bone', async () => {
    const models = new WeaponModels()
    await models.parseRifle(buf)
    for (const idx of [2]) {
      const b = models.build(idx)
      const ms = meshes(b.group)
      expect(b.group.getObjectByName('Carbine details')).toBeUndefined()
      const gun = b.group.getObjectByName('Gun')!
      expect(gun.visible).toBe(false)
      const own = ['metal', 'polymer', 'glass'].map((k) => b.group.getObjectByName(`Carbine-${k}`) as import('three').Mesh)
      expect(own.every((m) => m && m.userData.own === true)).toBe(true)
      // Riding the bone (so the skinned fire clip moves it): the parent chain reaches a bone.
      expect(own.every((m) => (m.parent!.parent as import('three').Bone)?.isBone || (m.parent as import('three').Bone).isBone)).toBe(true)
      // Draw calls: the hidden file gun gave 2; the procedural body, device and cuffs give 3 + 2 + 2 (5 more at most).
      let drawn = 0
      b.group.traverse((o) => {
        if ((o as import('three').Mesh).isMesh && o.visible && !(o.parent && !o.parent.visible)) drawn++
      })
      expect(drawn).toBeLessThanOrEqual(4 + 2 + 5)
      expect(ms.length).toBe(4)
      expect(ms.every((m) => (m as import('three').SkinnedMesh).isSkinnedMesh)).toBe(true)
      expect(ms.map((m) => m.geometry.type).every((t) => t === 'BufferGeometry')).toBe(true)
      expect(ms.map((m) => m.geometry.attributes.position!.count).sort((a, c) => a - c)).toEqual([56, 240, 240, 386])
      expect(b.ownHands).toBe(true)
      expect(b.fire).not.toBeNull()
    }
  })

  test('the opponent copy of the Carbine has its hands hidden; the muzzle is ahead of the barrel axis origin', async () => {
    const models = new WeaponModels()
    await models.parseRifle(buf)
    const c = models.build(2)
    expect(c.muzzle.position.z).toBeLessThan(-0.4)
    const held = models.build(2, false)
    expect(held.ownHands).toBe(false)
    const hands = meshes(held.group).filter((m) => m.name.startsWith('Hand'))
    expect(hands.length).toBe(2)
    expect(hands.every((m) => !m.visible)).toBe(true)
  })

  test('the file materials are swapped for PBR ones (metal, polymer, glove) and the long guns need the GLB to load', async () => {
    const models = new WeaponModels()
    expect(() => models.build(2)).toThrow()
    await models.parseRifle(buf)
    const names = new Set(meshes(models.build(2).group).map((m) => (m.material as import('three').Material).name))
    expect(names.has('GunMaterial')).toBe(false)
    expect(names.has('HandMaterial')).toBe(false)
  })

  /** Skinned vertices of a mesh in the gun group's space. */
  const groupVerts = (b: ReturnType<WeaponModels['build']>, mesh: SkinnedMesh): Vector3[] => {
    b.group.updateMatrixWorld(true)
    mesh.skeleton.update()
    const out: Vector3[] = []
    for (let i = 0; i < mesh.geometry.attributes.position!.count; i++) {
      const v = new Vector3()
      mesh.getVertexPosition(i, v)
      out.push(v.applyMatrix4(mesh.matrixWorld))
    }
    return out
  }

  test('the barrel constants match the mesh: the steel vertices near the muzzle centre on the group z axis and the muzzle marker sits on the tip', async () => {
    const models = new WeaponModels()
    await models.parseRifle(buf)
    // The file's steel mesh, found by its material name before the PBR swap.
    const raw = await new GLTFLoader().parseAsync(buf, '')
    let steel = ''
    raw.scene.traverse((o) => {
      const m = o as import('three').Mesh
      if (m.isMesh && (m.material as import('three').Material).name === 'GunMaterial') steel = m.name
    })
    expect(steel).not.toBe('')
    for (const idx of [2]) {
      const b = models.build(idx)
      const mesh = meshes(b.group).find((m) => m.name === steel) as SkinnedMesh
      const verts = groupVerts(b, mesh)
      const tip = Math.min(...verts.map((v) => v.z))
      const unit = b.muzzle.position.z / -6.54 // one file unit in metres (the scale)
      const near = verts.filter((v) => v.z < tip + unit)
      expect(near.length).toBeGreaterThan(8)
      const mid = (f: (v: Vector3) => number) => (Math.min(...near.map(f)) + Math.max(...near.map(f))) / 2
      expect(Math.abs(mid((v) => v.y))).toBeLessThan(0.001)
      expect(Math.abs(mid((v) => v.x))).toBeLessThan(0.001)
      // The marker sits on the tip of the muzzle device, which extends the barrel by a known length.
      const device = CARBINE_DEVICE_LENGTH
      expect(Math.abs(tip - (b.muzzle.position.z + device))).toBeLessThan(0.011) // the device overlaps the barrel by 8 to 10 mm
    }
  })

  test('the gloves are in frame: both hands keep most of their vertices on screen at the rest pose and no steel covers the crosshair', async () => {
    const models = new WeaponModels()
    await models.parseRifle(buf)
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, 16 / 9, 0.01, 5)
    for (const idx of [2]) {
      const b = models.build(idx)
      const vm = viewmodelPose(still(idx), opts)
      b.group.position.set(...vm.pos)
      b.group.rotation.set(...vm.rot)
      b.group.scale.setScalar(VIEWMODEL_RIFLE_SCALE)
      const hands: Record<string, number> = {}
      let covering = 0
      for (const mesh of meshes(b.group) as SkinnedMesh[]) {
        const verts = groupVerts(b, mesh).map((v) => v.project(cam))
        if (mesh.name.startsWith('Hand')) hands[mesh.name] = verts.filter((v) => Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1).length / verts.length
        else covering += verts.filter((v) => Math.abs(v.x) < 0.05 && Math.abs(v.y) < 0.1).length
      }
      expect(Object.keys(hands).sort()).toEqual(['Hand1', 'Hand2'])
      for (const [name, frac] of Object.entries(hands)) expect(frac, `weapon ${idx} ${name} on screen`).toBeGreaterThan(0.8)
      expect(covering, `weapon ${idx} gun vertices over the crosshair`).toBe(0)
    }
  })

  test('the procedural body stays out of the crosshair and below the sight line, fed by real bone matrices', async () => {
    const models = new WeaponModels()
    await models.parseRifle(buf)
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, 16 / 9, 0.01, 5)
    const b = models.build(2)
    const vm = viewmodelPose(still(2), opts)
    b.group.position.set(...vm.pos)
    b.group.rotation.set(...vm.rot)
    b.group.scale.setScalar(VIEWMODEL_RIFLE_SCALE)
    b.group.updateMatrixWorld(true)
    let covering = 0
    for (const k of ['metal', 'polymer', 'glass']) {
      const mesh = b.group.getObjectByName(`Carbine-${k}`) as import('three').Mesh
      const pos = mesh.geometry.attributes.position!
      for (let i = 0; i < pos.count; i++) {
        const v = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).project(cam)
        if (Math.abs(v.x) < 0.05 && Math.abs(v.y) < 0.1) covering++
      }
    }
    expect(covering).toBe(0)
  })

  test('no steel or furniture of the rifle rises above the crosshair line at the rest pose (the opponent stays visible), hands stay in frame', async () => {
    const models = new WeaponModels()
    await models.parseRifle(buf)
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, 16 / 9, 0.01, 5)
    for (const idx of [2]) {
      const b = models.build(idx)
      const vm = viewmodelPose(still(idx), opts)
      b.group.position.set(...vm.pos)
      b.group.rotation.set(...vm.rot)
      b.group.scale.setScalar(VIEWMODEL_RIFLE_SCALE)
      let top = -Infinity
      for (const mesh of meshes(b.group) as SkinnedMesh[]) {
        if (mesh.name.startsWith('Hand')) continue
        for (const v of groupVerts(b, mesh)) top = Math.max(top, v.project(cam).y)
      }
      expect(top, `weapon ${idx} highest non-hand vertex in NDC y`).toBeLessThanOrEqual(0)
    }
  })

})

describe('the Ridgeline is the Poly Haven bolt action rifle, not the OGA rifle', () => {
  const both = async (): Promise<WeaponModels> => {
    const models = new WeaponModels()
    await models.parseRifle(buf)
    await models.parseBolt(boltGlb())
    return models
  }
  /** The meshes that are drawn: visible themselves and under no hidden parent. */
  const allMeshes = (root: import('three').Object3D) => {
    const out: import('three').Mesh[] = []
    const shown = (o: import('three').Object3D): boolean => o.visible && (o.parent === null || shown(o.parent))
    root.traverse((o) => {
      if ((o as import('three').Mesh).isMesh && shown(o)) out.push(o as import('three').Mesh)
    })
    return out
  }

  test('it is plain glTF meshes (no skeleton, no OGA hands), shown without its scope, with gloves drawn by the viewmodel', async () => {
    const models = await both()
    const b = models.build(1)
    const ms = allMeshes(b.group).filter((m) => m.visible)
    expect(ms.some((m) => (m as SkinnedMesh).isSkinnedMesh)).toBe(false)
    expect(ms.some((m) => m.name.startsWith('Hand'))).toBe(false)
    expect(b.ownHands).toBe(false)
    expect(b.fire).toBeNull()
    // The file's body (7636 vertices) is there; the scope (6890) is not drawn.
    const counts = ms.map((m) => m.geometry.attributes.position!.count)
    expect(counts).toContain(7636)
    expect(counts).not.toContain(6890)
    expect(b.gripDrop).toBeGreaterThan(0.05)
  })

  test('it is a different, longer rifle than the Carbine: the bolt rifle is over 1.3 times the Carbine length and lacks its vented compensator', async () => {
    const models = await both()
    const length = (idx: number) => {
      const b = models.build(idx)
      b.group.updateMatrixWorld(true)
      const box = new Box3()
      allMeshes(b.group).filter((m) => m.visible && !m.name.startsWith('Hand')).forEach((m) => box.expandByObject(m))
      return box.max.z - box.min.z
    }
    expect(length(1)).toBeGreaterThan(1.3 * length(2))
    const names: string[] = []
    models.build(1).group.traverse((o) => names.push(o.name))
    expect(names.some((n) => n.startsWith('Device'))).toBe(false)
  })

  test('the muzzle marker sits on the tip of the barrel, on the bore axis, and the barrel is the file mesh at the tip', async () => {
    const models = await both()
    const b = models.build(1)
    b.group.updateMatrixWorld(true)
    const box = new Box3()
    allMeshes(b.group).filter((m) => m.visible).forEach((m) => box.expandByObject(m))
    expect(Math.abs(box.min.z - b.muzzle.position.z)).toBeLessThan(0.006)
    expect(b.muzzle.position.z).toBeCloseTo(BOLT_MUZZLE_Z, 6)
    expect(b.muzzle.position.x).toBe(0)
    expect(b.muzzle.position.y).toBe(0)
    // The barrel tip vertices centre on the group's z axis (x and y near 0).
    const tip = new Box3()
    allMeshes(b.group).filter((m) => m.visible).forEach((m) => {
      const pos = m.geometry.attributes.position!
      for (let i = 0; i < pos.count; i++) {
        const v = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
        if (v.z < box.min.z + 0.01) tip.expandByPoint(v)
      }
    })
    const c = tip.getCenter(new Vector3())
    expect(Math.abs(c.x)).toBeLessThan(0.003)
    expect(Math.abs(c.y)).toBeLessThan(0.003)
  })

  test('it keeps the file PBR materials (wood and steel maps), not the OGA re-skin', async () => {
    const models = await both()
    const names = new Set(allMeshes(models.build(1).group).map((m) => (m.material as import('three').Material).name))
    expect(names.has('bolt_action_rifle_7_62')).toBe(true)
    expect(names.has('GunMaterial')).toBe(false)
  })

  test('its gloves are in frame and no steel or wood rises above the crosshair line at the rest pose', async () => {
    const models = await both()
    const cam = new PerspectiveCamera(VIEWMODEL_FOV, 16 / 9, 0.01, 5)
    const b = models.build(1)
    const vm = viewmodelPose(still(1), opts)
    b.group.position.set(...vm.pos)
    b.group.rotation.set(...vm.rot)
    b.group.scale.setScalar(VIEWMODEL_RIFLE_SCALE)
    b.group.updateMatrixWorld(true)
    let top = -Infinity
    let covering = 0
    for (const m of allMeshes(b.group).filter((x) => x.visible)) {
      const pos = m.geometry.attributes.position!
      for (let i = 0; i < pos.count; i++) {
        const v = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(cam)
        top = Math.max(top, v.y)
        if (Math.abs(v.x) < 0.05 && Math.abs(v.y) < 0.1) covering++
      }
    }
    expect(top).toBeLessThanOrEqual(0)
    expect(covering).toBe(0)
  })
})


describe('the procedural arms on a weapon swap', () => {
  test('the old glove, forearm and cuff geometries are disposed when the next weapon builds its arms', async () => {
    const g = globalThis as unknown as { document?: unknown }
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' }) }),
    }
    const models = new WeaponModels()
    await models.parseRifle(buf)
    await models.parseBolt(boltGlb())
    const vm = new Viewmodel(models)
    const p = makePlayer()
    p.weapon = 0
    vm.update(1 / 60, p, 99, false)
    const arms = (vm as unknown as { arms: import('three').Group }).arms
    const old = arms.children.map((c) => (c as import('three').Mesh).geometry)
    expect(old.length).toBe(6)
    let disposed = 0
    for (const geo of old) geo.addEventListener('dispose', () => disposed++)
    p.weapon = 1
    vm.update(1 / 60, p, 99, false)
    expect(disposed).toBe(6)
  })
})
