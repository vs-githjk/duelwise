import { buildCarbineGeometry } from './carbine-geo'
import {
  AdditiveBlending, AnimationMixer, BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, CylinderGeometry, DataTexture, Group, LinearFilter, LoopOnce, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, NoColorSpace, Object3D,
  PerspectiveCamera, PlaneGeometry, PointLight, Quaternion, RepeatWrapping, RGBAFormat, Scene, SRGBColorSpace, Texture, TextureLoader, Vector3,
} from 'three'
import type { AnimationAction } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { ACCURATE_FRACTION, AIR_SPREAD, WEAPONS } from '@duelwise/core/src/games/arena/weapons.ts'
import type { Player } from '@duelwise/core/src/games/arena/state.ts'
import { radialTexture } from './map-mesh'

// The weapon in your hands: the sidearm (Dart) is the CC0 Poly Haven service pistol, the Ridgeline is the CC0 Poly
// Haven bolt action 7.62 rifle (its own PBR wood and steel, held with capsule gloves), and the Carbine is the CC0
// OpenGameArt low poly fps rifle (gun, gloved hands, shoot clip) re-skinned with Poly Haven metal, polymer and
// leather PBR sets, so the two read apart at a glance (JC2 fix 5). Recoil, bob, reload
// and the raise are pure functions of sim state (viewmodelPose); spreadOf gives the same spread the
// sim uses, in tangent space, for the crosshair gap.

const PISTOL_URL = '/assets/arena/polyhaven/service_pistol/service_pistol_1k.gltf'
/** Viewmodel field of view: narrower than the world camera so the gun does not look stretched. */
export const VIEWMODEL_FOV = 58
const RIFLE_URL = '/assets/arena/oga-rifle/rifle.glb'
const BOLT_URL = '/assets/arena/polyhaven/bolt_action_rifle_7_62/bolt_action_rifle_7_62_1k.gltf'
const TAU = Math.PI * 2

export interface VmPose {
  /** Camera space metres (x right, y up, -z forward). */
  pos: [number, number, number]
  /** Radians. */
  rot: [number, number, number]
  /** Muzzle flash strength 0..1. */
  flash: number
}

export interface PoseOptions {
  /** Seconds, for bob and breathing. */
  time: number
  /** 0..1, 1 when the weapon is fully up. */
  raise: number
  reduced?: boolean
}

/** The sim's spread for the seat's next shot (tangent space), copied from core.ts shoot(). */
export function spreadOf(p: Player): number {
  const w = WEAPONS[p.weapon]!
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
  let spread = 0
  if (p.onGround === 0) spread = AIR_SPREAD
  else if (speed > w.maxSpeed * ACCURATE_FRACTION + 0.5) spread = (w.moveSpread * speed) / w.maxSpeed
  spread += w.fireSpread * (p.recoilIdx > 10 ? 10 : p.recoilIdx)
  return spread
}

/** Spread as a half angle in degrees (what the crosshair gap shows). */
export const spreadDegrees = (p: Player): number => (Math.atan(spreadOf(p)) * 180) / Math.PI

const BASE: Record<number, [number, number, number]> = {
  0: [0.085, -0.135, -0.3],
  // The rifles sit low in the bottom right quadrant, the way the reference shooter draws them: nothing of the gun or the gloves covers the band right of the crosshair at eye height (placement.test.ts), while receiver, magazine and sight stay on screen.
  1: [0.26, -0.22, -0.72],
  2: [0.26, -0.22, -0.68],
}

/** The first person rifles are drawn at this fraction of their world size, so they sit low and right and leave the crosshair band clear. The opponent's copy is not scaled. */
export const VIEWMODEL_RIFLE_SCALE = 0.6

/** Muzzle flash strength as drawn: capped at 0.4 when the player asked for reduced motion. */
export function flashStrength(flash: number, reduced: boolean): number {
  return reduced ? Math.min(flash, 0.4) : flash
}

export function viewmodelPose(p: Player, o: PoseOptions): VmPose {
  const w = WEAPONS[p.weapon]!
  const base = BASE[p.weapon] ?? BASE[0]!
  const pos: [number, number, number] = [base[0], base[1], base[2]]
  // The rifles are angled in a little so the side of the gun shows, the way a held rifle reads.
  const rot: [number, number, number] = [0, p.weapon === 0 ? 0 : 0.12, 0]
  const calm = o.reduced ? 0.25 : 1

  // Recoil kick: snaps back and up, then eases out over about 12 frames.
  const s = p.sinceShot
  const k = s < 40 ? Math.exp(-s / 4) : 0
  pos[2] += 0.045 * k * calm
  pos[1] += 0.008 * k * calm
  rot[0] += 0.14 * k * calm

  // Walk bob and breathing.
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
  const m = p.onGround === 1 ? Math.min(1, speed / w.maxSpeed) : 0
  pos[1] += Math.sin(o.time * 11) * 0.004 * m * calm + Math.sin(o.time * 1.7) * 0.0015
  pos[0] += Math.cos(o.time * 5.5) * 0.004 * m * calm
  rot[2] += Math.sin(o.time * 5.5) * 0.012 * m * calm
  if (p.onGround === 0) {
    pos[1] -= 0.012
    rot[0] += 0.04
  }

  // Reload: the weapon dips and tilts to the side, then comes back (reload frames left run down to 0).
  if (p.reload > 0) {
    const prog = 1 - p.reload / w.reloadFrames
    const dip = Math.sin(Math.PI * Math.min(1, Math.max(0, prog)))
    pos[1] -= 0.15 * dip
    pos[0] -= 0.05 * dip
    rot[0] -= 0.55 * dip
    rot[2] += 0.5 * dip
  }

  // Raise after a weapon change or a new round.
  const r = Math.min(1, Math.max(0, o.raise))
  const lower = (1 - r) * (1 - r)
  pos[1] -= 0.3 * lower
  rot[0] -= 0.7 * lower

  const flash = s === 0 || s === 1 ? 1 : s === 2 ? 0.5 : 0
  return { pos, rot, flash }
}

// ---------------------------------------------------------------- models

interface Built {
  group: Group
  /** Muzzle tip in the group's space. */
  muzzle: Object3D
  /** Where the right and left gloves sit, and where the left forearm comes from (gun space). */
  gripR: [number, number, number]
  gripL: [number, number, number]
  handLArm: [number, number, number]
  /** True when the model carries its own gloved hands (the rifle GLB), so no capsule arms are drawn. */
  ownHands: boolean
  /** Metres from the barrel axis (the group origin) down to the palm; 0 for the pistol. */
  gripDrop: number
  /** The rifle's own shoot clip, restarted on every shot; null for the pistol. */
  mixer: AnimationMixer | null
  fire: AnimationAction | null
}

function box(w: number, h: number, d: number, mat: MeshStandardMaterial, x: number, y: number, z: number): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  return m
}

const polymer = (): MeshStandardMaterial => new MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7, metalness: 0.1 })

// ---- the OGA low poly fps rifle (CC0): one mesh pair for the gun, two gloved hands, one bone, a shoot clip.
// Units in the file are about 7.7 long; the barrel runs along -z, the pistol grip is at z 0, the barrel axis is at y 1.55.
const RIFLE_BARREL_Y = 1.55
const RIFLE_MUZZLE_Z = -6.54
const RIFLE_GRIP_DROP = 2.25
/** Scale from file units to metres of the OGA rifle (the Carbine). */
const RIFLE_SCALE: Record<number, number> = { 2: 0.095 }

// ---- the Poly Haven bolt action rifle (CC0, metres): the muzzle is at file x +0.596, the bore axis at y 0.0516, the stock wrist (where the
// right palm sits, behind the trigger at x -0.29) at x -0.36. The scope is left out so the sight picture stays clear (nothing rises above the barrel).
const BOLT_SCALE = 1.15
const BOLT_MUZZLE_X = 0.596
const BOLT_BORE_Y = 0.0516
const BOLT_GRIP_X = -0.36
/** Metres from the bore axis down to the right palm, at BOLT_SCALE. */
const BOLT_GRIP_DROP = 0.1 * BOLT_SCALE
/** The bolt rifle's muzzle in the group (negative z, metres, before any viewmodel scale): the barrel runs along -z with the grip at z 0. */
export const BOLT_MUZZLE_Z = -(BOLT_MUZZLE_X - BOLT_GRIP_X) * BOLT_SCALE
/** Metres the Carbine's compensator adds in front of the barrel (see WeaponModels.addMuzzleDevice). */
export const CARBINE_DEVICE_LENGTH = 0.05

export type PbrKind = 'metal' | 'polymer' | 'glove'
/** `tile` is how many file units one texture repeat covers (the file's own UVs are a stretched cube net, so they are rebuilt, see boxUv). */
export const PBR_SETS: Record<PbrKind, { id: string; tint: number; metalness: number; tile: number; roughness?: number; normalScale?: number }> = {
  metal: { id: 'blue_metal_plate', tint: 0x7d838b, metalness: 0.8, tile: 3 },
  polymer: { id: 'rubberized_track', tint: 0x5c6066, metalness: 0.05, tile: 1.6 },
  // The gloves: dark tactical fabric (charcoal tint, rough, a fine weave from the CC0 fabric normal map), roughness 0.92 as set (the roughness map is left off so the number is the number), normal detail from the CC0 fabric set.
  glove: { id: 'fabric_leather_02', tint: 0x54555c, metalness: 0, tile: 0.55, roughness: 0.92, normalScale: 0.7 },
}
/** The file's three materials, re-skinned with Poly Haven PBR sets (metal for the steel, polymer for the furniture, leather for the gloves). */
const RIFLE_MATERIAL: Record<string, PbrKind> = { GunMaterial: 'metal', GunWood: 'polymer', HandMaterial: 'glove' }
const pbrUrl = (id: string, kind: 'diff' | 'nor_gl' | 'rough'): string => `/assets/arena/polyhaven/${id}/${id}_${kind}_1k.webp`

/** The nodes of the Poly Haven pistol file that make the assembled pistol (variant a, loaded magazine). */
const PISTOL_PARTS = new Set(['service_pistol_pistol_a', 'service_pistol_slide_a', 'service_pistol_magazine_loaded', 'service_pistol_hammer_a', 'service_pistol_trigger_a'])

/**
 * Rebuilds a mesh's UVs by box projection (each vertex takes the two axes across its dominant normal axis),
 * so a tiling PBR set keeps a constant texel size and does not streak over the file's stretched cube net.
 * The file duplicates vertices per face, so a vertex has one face normal. Skinning stays valid (UVs only).
 */
export function boxUv(geo: BufferGeometry, perUnit: number): void {
  const pos = geo.attributes.position!
  const nor = geo.attributes.normal!
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i))
    const ny = Math.abs(nor.getY(i))
    const nz = Math.abs(nor.getZ(i))
    const [u, v] = nx >= ny && nx >= nz ? [pos.getZ(i), pos.getY(i)] : ny >= nz ? [pos.getX(i), pos.getZ(i)] : [pos.getX(i), pos.getY(i)]
    uv[i * 2] = u * perUnit
    uv[i * 2 + 1] = v * perUnit
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2))
}

/** A glove cuff in file space: a band round the forearm just behind the palm. */
export interface Cuff {
  hand: string
  center: [number, number, number]
  /** Rotates the band's local z onto the forearm axis. */
  quat: [number, number, number, number]
  /** Across, across, along the forearm (file units). */
  size: [number, number, number]
}

/**
 * Finds where the glove ends and the forearm starts on one of the file's hand meshes. The mesh is a loft: a finger
 * cluster, a palm ring and an arm end ring, with the largest gap in z between the palm ring and the arm end. The
 * cuff sits a third of the way along that forearm, a little wider than the forearm there so its edge shows.
 */
export function cuffFor(hand: string, geo: BufferGeometry): Cuff {
  const pos = geo.attributes.position!
  const zs: number[] = []
  for (let i = 0; i < pos.count; i++) zs.push(pos.getZ(i))
  const sorted = [...new Set(zs.map((z) => Math.round(z * 100) / 100))].sort((a, b) => a - b)
  let gap = 0
  let at = 0
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! > gap) {
      gap = sorted[i]! - sorted[i - 1]!
      at = i
    }
  }
  const lo = sorted[at - 1]!
  const hi = sorted[at]!
  const ring = (test: (z: number) => boolean): { c: Vector3; w: number; h: number } => {
    const mn = new Vector3(1e9, 1e9, 1e9)
    const mx = new Vector3(-1e9, -1e9, -1e9)
    const sum = new Vector3()
    let n = 0
    for (let i = 0; i < pos.count; i++) {
      if (!test(pos.getZ(i))) continue
      const v = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
      mn.min(v)
      mx.max(v)
      sum.add(v)
      n++
    }
    if (n === 0) throw new Error(`cuffFor(${hand}): no vertices in the ring`)
    return { c: sum.multiplyScalar(1 / n), w: mx.x - mn.x, h: mx.y - mn.y }
  }
  const palm = ring((z) => z <= lo + 0.005 && z > lo - 0.35)
  const end = ring((z) => z >= hi - 0.005 && z < hi + 0.35)
  const t = 0.33
  const center = palm.c.clone().lerp(end.c, t)
  const axis = end.c.clone().sub(palm.c).normalize()
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), axis)
  const w = palm.w + (end.w - palm.w) * t
  const h = palm.h + (end.h - palm.h) * t
  return { hand, center: [center.x, center.y, center.z], quat: [q.x, q.y, q.z, q.w], size: [w + 0.24, h + 0.24, 0.5] }
}

export class WeaponModels {
  private pistol: Object3D | null = null
  private rifle: GLTF | null = null
  private bolt: GLTF | null = null
  /** The file's two hand meshes' cuffs, in file space (see cuffFor). */
  private cuffs: Cuff[] = []
  private readonly mats: Record<PbrKind, MeshStandardMaterial> = {
    metal: this.pbrMaterial('metal'),
    polymer: this.pbrMaterial('polymer'),
    glove: this.pbrMaterial('glove'),
  }

  /** The PBR glove material (fabric normal detail, roughness 0.7), shared by the rifle hands and the pistol hands. */
  get gloveMaterial(): MeshStandardMaterial {
    return this.mats.glove
  }

  /** The dark cuff band that edges each glove (plain, so the edge reads against the fabric). */
  readonly cuffMaterial = new MeshStandardMaterial({ color: 0x24272b, roughness: 0.85, metalness: 0.05 })

  private pbrMaterial(kind: PbrKind): MeshStandardMaterial {
    const set = PBR_SETS[kind]
    return new MeshStandardMaterial({ color: set.tint, roughness: set.roughness ?? 0.6, metalness: set.metalness })
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader()
    const [gltf, rifle, bolt] = await Promise.all([loader.loadAsync(PISTOL_URL), loader.loadAsync(RIFLE_URL), loader.loadAsync(BOLT_URL), this.loadTextures()])
    this.usePistol(gltf)
    this.useRifle(rifle)
    this.useBolt(bolt)
  }

  /** The three Poly Haven sets at 1k WebP, set on the shared materials (sRGB for the colour map only). */
  private async loadTextures(): Promise<void> {
    const tl = new TextureLoader()
    const get = async (url: string, srgb: boolean): Promise<Texture> => {
      const t = await tl.loadAsync(url)
      t.wrapS = t.wrapT = RepeatWrapping
      t.anisotropy = 8
      if (srgb) t.colorSpace = SRGBColorSpace
      return t
    }
    await Promise.all(
      (Object.keys(PBR_SETS) as PbrKind[]).map(async (kind) => {
        const set = PBR_SETS[kind]
        const fixed = set.roughness !== undefined
        const [map, normalMap, roughnessMap] = await Promise.all([
          get(pbrUrl(set.id, 'diff'), true),
          get(pbrUrl(set.id, 'nor_gl'), false),
          fixed ? Promise.resolve(null) : get(pbrUrl(set.id, 'rough'), false),
        ])
        const m = this.mats[kind]
        m.map = map
        m.normalMap = normalMap
        if (set.normalScale) m.normalScale.set(set.normalScale, set.normalScale)
        m.roughnessMap = roughnessMap
        m.roughness = set.roughness ?? 1
        m.needsUpdate = true
      }),
    )
  }

  /** Parses the rifle GLB from bytes (tests use this; the game uses load()). */
  async parseRifle(bytes: ArrayBuffer): Promise<void> {
    this.useRifle(await new GLTFLoader().parseAsync(bytes, ''))
  }

  /** Parses the bolt rifle from GLB bytes (tests use this, with the textures stripped; the game uses load()). */
  async parseBolt(bytes: ArrayBuffer): Promise<void> {
    this.useBolt(await new GLTFLoader().parseAsync(bytes, ''))
  }

  /** The Ridgeline: the file's meshes as they are (its own PBR wood and steel), minus the scope so the sight picture stays clear. */
  private useBolt(gltf: GLTF): void {
    gltf.scene.traverse((o) => {
      if (o.name.endsWith('_scope')) o.visible = false
      const m = o as Mesh
      if (!m.isMesh) return
      m.frustumCulled = false
      m.castShadow = false
    })
    this.bolt = gltf
  }

  /** The Ridgeline model: the bolt rifle turned to point down -z, its bore axis and right palm placed on the group's origin conventions (see BOLT_*). */
  private buildBolt(): Built {
    const g = new Group()
    const model = this.bolt!.scene.clone(true)
    // In file units, before the pivot's turn and scale: the wrist goes to x 0 and the bore axis to y 0.
    model.position.set(-BOLT_GRIP_X, -BOLT_BORE_Y, 0)
    // File +x (the muzzle) becomes group -z.
    const pivot = new Group()
    pivot.rotation.y = Math.PI / 2
    pivot.scale.setScalar(BOLT_SCALE)
    pivot.add(model)
    g.add(pivot)
    const muzzle = new Object3D()
    muzzle.position.set(0, 0, BOLT_MUZZLE_Z)
    g.add(muzzle)
    // Gloves (gun space, metres): the right palm on the stock wrist behind the trigger, the left under the forestock.
    const gripR: [number, number, number] = [0, -0.1 * BOLT_SCALE, 0.02]
    const gripL: [number, number, number] = [0, -0.07 * BOLT_SCALE, -0.38 * BOLT_SCALE]
    return { group: g, muzzle, gripR, gripL, handLArm: [0.12, -0.25, 0.05], ownHands: false, gripDrop: BOLT_GRIP_DROP, mixer: null, fire: null }
  }

  private useRifle(gltf: GLTF): void {
    gltf.scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      m.frustumCulled = false
      m.castShadow = false
      const swap = (mat: Material): Material => {
        const kind = RIFLE_MATERIAL[mat.name]
        return kind ? this.mats[kind] : mat
      }
      const kind = RIFLE_MATERIAL[(Array.isArray(m.material) ? m.material[0]! : m.material).name]
      if (kind) boxUv(m.geometry, 1 / PBR_SETS[kind].tile)
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
    })
    this.cuffs = []
    gltf.scene.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh && (m.name === 'Hand1' || m.name === 'Hand2')) this.cuffs.push(cuffFor(m.name, m.geometry))
    })
    this.rifle = gltf
  }

  private usePistol(gltf: GLTF): void {
    const root = gltf.scene
    // The file lays out spare parts side by side (a second pistol, an empty magazine, a bullet, the loaded
    // magazine pulled out by 0.1 m). Keep the assembled pistol and put the magazine back in the grip.
    const drop: Object3D[] = []
    root.traverse((o) => {
      if (o.name.startsWith('service_pistol_') && !PISTOL_PARTS.has(o.name)) drop.push(o)
      if (o.name === 'service_pistol_magazine_loaded') o.position.set(0, 0, 0)
    })
    for (const o of drop) o.removeFromParent()
    const wrap = new Group()
    wrap.add(root)
    // The pistol file points its barrel along +x; the viewmodel looks down -z.
    wrap.rotation.y = Math.PI / 2
    root.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) m.castShadow = false
    })
    this.pistol = wrap
  }

  /** Glove cuffs as bands parented to the rifle's bone, so they follow the shoot clip with the hands. */
  private addCuffs(inner: Group): void {
    let bone: Object3D | null = null
    inner.traverse((o) => {
      if (!bone && (o as import('three').Bone).isBone) bone = o
    })
    if (!bone) return
    const bn = bone as Object3D
    inner.updateMatrixWorld(true)
    for (const c of this.cuffs) {
      const mesh = new Mesh(new BoxGeometry(c.size[0], c.size[1], c.size[2]).toNonIndexed(), this.cuffMaterial)
      mesh.name = `Cuff${c.hand.slice(-1)}`
      mesh.userData.own = true
      mesh.frustumCulled = false
      // File space to the bone's space, through the world (the bone has its own rest transform).
      const world = new Vector3(...c.center).applyMatrix4(inner.matrixWorld)
      mesh.position.copy(bn.worldToLocal(world))
      const wq = new Quaternion().setFromRotationMatrix(inner.matrixWorld).multiply(new Quaternion(...c.quat))
      const bq = new Quaternion().setFromRotationMatrix(bn.matrixWorld).invert()
      mesh.quaternion.copy(bq.multiply(wq))
      const sc = new Vector3().setFromMatrixScale(inner.matrixWorld).x / new Vector3().setFromMatrixScale(bn.matrixWorld).x
      mesh.scale.setScalar(sc)
      bn.add(mesh)
    }
  }

  /** The anodized metal and polymer furniture materials of the procedural Carbine, with a noise roughness map for variation. */
  private carbineMats: { metal: MeshStandardMaterial; polymer: MeshStandardMaterial; glass: MeshStandardMaterial } | null = null
  private carbineMaterials() {
    if (this.carbineMats) return this.carbineMats
    const n = 64
    const data = new Uint8Array(n * n * 4)
    let seed = 7
    for (let i = 0; i < n * n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const v = 120 + ((seed >>> 24) % 110)
      data.set([v, v, v, 255], i * 4)
    }
    const noise = new DataTexture(data, n, n, RGBAFormat)
    noise.wrapS = noise.wrapT = RepeatWrapping
    noise.repeat.set(3, 3)
    noise.colorSpace = NoColorSpace
    noise.magFilter = noise.minFilter = LinearFilter
    noise.needsUpdate = true
    this.carbineMats = {
      metal: new MeshStandardMaterial({ name: 'CarbineMetal', color: 0x6a717b, metalness: 0.85, roughness: 0.7, roughnessMap: noise }),
      polymer: new MeshStandardMaterial({ name: 'CarbinePolymer', color: 0x2a2d32, metalness: 0.05, roughness: 0.85, roughnessMap: noise, bumpMap: noise, bumpScale: 0.08 }),
      glass: new MeshStandardMaterial({ name: 'CarbineGlass', color: 0x0a1218, metalness: 0.2, roughness: 0.08, emissive: 0x0b2a3a, emissiveIntensity: 0.5 }),
    }
    return this.carbineMats
  }

  /** The Carbine's body: three merged procedural meshes (metal, polymer, optic glass) attached to the rifle's bone. */
  private addCarbineBody(g: Group, inner: Group, muzzleZ: number): void {
    const geo = buildCarbineGeometry(muzzleZ)
    const mats = this.carbineMaterials()
    const rig = new Group()
    rig.name = 'Carbine body'
    for (const [name, mat] of [['metal', mats.metal], ['polymer', mats.polymer], ['glass', mats.glass]] as const) {
      const m = new Mesh(geo[name], mat)
      m.name = `Carbine-${name}`
      m.frustumCulled = false
      m.userData.own = true
      rig.add(m)
    }
    g.add(rig)
    let bone: Object3D | null = null
    inner.traverse((o) => {
      if (!bone && (o as import('three').Bone).isBone) bone = o
    })
    if (bone) {
      g.updateMatrixWorld(true)
      ;(bone as Object3D).attach(rig)
    }
  }

  /** The Carbine's short wide vented compensator, on the barrel axis (nothing rises above the barrel, so the sight picture is unchanged). Returns the z of the new tip (the bullet and flash leave there). */
  private addMuzzleDevice(g: Group, muzzleZ: number): number {
    const mats = this.carbineMaterials()
    const len = CARBINE_DEVICE_LENGTH
    const geo = new CylinderGeometry(0.019, 0.019, len, 14, 1)
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, 0, muzzleZ - len / 2 + 0.008)
    const body = new Mesh(geo, mats.metal)
    body.name = 'Device-body'
    body.userData.own = true
    const vents = new Mesh(new CylinderGeometry(0.0205, 0.0205, 0.008, 14, 1).rotateX(-Math.PI / 2).translate(0, 0, muzzleZ - len * 0.55), mats.polymer)
    vents.name = 'Device-vents'
    vents.userData.own = true
    g.add(body, vents)
    return muzzleZ - len + 0.008
  }

  /**
   * A fresh model of weapon `idx` with a muzzle marker and hand positions (gun space, metres). The rifle's
   * origin is on its barrel axis; `hands` false hides the gloved hands (the opponent holds it with its own).
   */
  build(idx: number, hands = true): Built {
    if (idx === 0) {
      const g = new Group()
      if (this.pistol) g.add(this.pistol.clone(true))
      else g.add(box(0.03, 0.05, 0.2, polymer(), 0, 0.02, -0.1))
      const muzzle = new Object3D()
      muzzle.position.set(0, 0.062, -0.176)
      g.add(muzzle)
      return { group: g, muzzle, gripR: [0, -0.03, 0.01], gripL: [-0.03, -0.045, 0.0], handLArm: [-0.2, -0.3, 0.25], ownHands: false, gripDrop: 0, mixer: null, fire: null }
    }
    if (idx === 1) {
      if (!this.bolt) throw new Error('bolt rifle glTF not loaded')
      return this.buildBolt()
    }
    if (!this.rifle) throw new Error('rifle GLB not loaded')
    const s = RIFLE_SCALE[idx] ?? RIFLE_SCALE[2]!
    const g = new Group()
    const inner = cloneSkinned(this.rifle.scene) as Group
    inner.scale.setScalar(s)
    inner.position.set(0, -RIFLE_BARREL_Y * s, 0)
    inner.traverse((o) => {
      if (!hands && (o.name === 'Hand1' || o.name === 'Hand2')) o.visible = false
    })
    g.add(inner)
    // The file's blocky gun mesh is replaced by a procedural carbine riding the same bone, so it follows the skinned fire clip.
    inner.traverse((o) => {
      if (o.name === 'Gun') o.visible = false
    })
    this.addCarbineBody(g, inner, RIFLE_MUZZLE_Z * s)
    if (hands) this.addCuffs(inner)
    const muzzle = new Object3D()
    const tip = this.addMuzzleDevice(g, RIFLE_MUZZLE_Z * s)
    muzzle.position.set(0, 0, tip)
    g.add(muzzle)
    const clip = this.rifle.animations.find((c) => c.name === 'fire')
    const mixer = clip ? new AnimationMixer(inner) : null
    const fire = mixer && clip ? mixer.clipAction(clip) : null
    if (fire) {
      fire.setLoop(LoopOnce, 1)
      fire.clampWhenFinished = false
    }
    return { group: g, muzzle, gripR: [0, 0, 0], gripL: [0, 0, 0], handLArm: [0, 0, 0], ownHands: hands, gripDrop: RIFLE_GRIP_DROP * s, mixer, fire }
  }
}

/** Frees the geometry of the meshes a build made itself (marked userData.own); the shared glTF geometry and the shared materials stay. */
export function disposeBuilt(group: Object3D): void {
  group.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh && m.userData.own) m.geometry.dispose()
  })
}

// ---------------------------------------------------------------- viewmodel rig

/** The gun, a gloved forearm pair and the muzzle flash in their own scene, drawn after the world with the depth cleared. */
export class Viewmodel {
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(VIEWMODEL_FOV, 16 / 9, 0.01, 5)
  private holder = new Group()
  private gun: Built | null = null
  private weapon = -1
  private flashMesh: Mesh
  readonly flashLight = new PointLight(0xffc27a, 0, 3, 2)
  private arms = new Group()
  private sleeveMat = new MeshStandardMaterial({ color: 0x2c343c, roughness: 0.9 })
  private raise = 0
  private tmp = new Vector3()
  time = 0

  constructor(private readonly models: WeaponModels) {
    this.scene.add(this.camera)
    this.camera.add(this.holder)
    this.camera.add(this.flashLight)
    const tex = radialTexture('rgba(255,244,214,1)', 'rgba(255,150,40,0)', 64)
    this.flashMesh = new Mesh(
      new PlaneGeometry(0.22, 0.22),
      new MeshBasicMaterial({ map: tex, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0 }),
    )
    this.flashMesh.visible = false
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  /** A capsule from `a` to `b` (gun space). */
  private limb(a: Vector3, b: Vector3, radius: number, mat: MeshStandardMaterial): Mesh {
    const dir = b.clone().sub(a)
    const len = dir.length()
    const m = new Mesh(new CapsuleGeometry(radius, Math.max(0.001, len - 2 * radius), 4, 10), mat)
    m.position.copy(a).add(b).multiplyScalar(0.5)
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize())
    return m
  }

  /** A finer weave on the capsule gloves: the capsule's UVs run 0..1 once round, so tile them. */
  private glove(radius: number, length: number): Mesh {
    const geo = new CapsuleGeometry(radius, length, 4, 10)
    const uv = geo.attributes.uv!
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2.5, uv.getY(i) * 2.5)
    return new Mesh(geo, this.models.gloveMaterial)
  }

  private rebuildArms(b: Built): void {
    // The gloves, forearms and cuffs own their geometry (the materials are shared), so free it before the next weapon's arms replace them.
    for (const child of this.arms.children) (child as Mesh).geometry?.dispose()
    this.arms.clear()
    if (b.ownHands) return
    const gR = new Vector3(...b.gripR)
    const gL = new Vector3(...b.gripL)
    const handR = this.glove(0.03, 0.05)
    handR.position.copy(gR).add(new Vector3(0.012, 0, 0.005))
    const handL = this.glove(0.03, 0.04)
    handL.rotation.x = Math.PI / 2
    handL.position.copy(gL)
    // Forearms run back and down out of the frame.
    const foreR = this.limb(gR.clone().add(new Vector3(0.01, -0.03, 0.05)), new Vector3(0.1, -0.3, 0.42), 0.036, this.sleeveMat)
    const foreL = this.limb(gL.clone().add(new Vector3(-0.01, -0.02, 0.04)), new Vector3(...b.handLArm).add(new Vector3(-0.04, -0.1, 0.2)), 0.034, this.sleeveMat)
    // A visible cuff edge where each glove meets its sleeve.
    const cuff = (at: Vector3, toward: Vector3): Mesh => {
      const m = new Mesh(new CylinderGeometry(0.038, 0.038, 0.016, 14), this.models.cuffMaterial)
      m.position.copy(at)
      m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), toward.clone().normalize())
      return m
    }
    const cuffR = cuff(gR.clone().add(new Vector3(0.012, -0.045, 0.035)), new Vector3(0.1, -0.3, 0.42))
    const cuffL = cuff(gL.clone().add(new Vector3(-0.012, -0.04, 0.045)), new Vector3(...b.handLArm).add(new Vector3(-0.04, -0.1, 0.2)).sub(gL))
    this.arms.add(handR, handL, foreR, foreL, cuffR, cuffL)
  }

  private swap(idx: number): void {
    if (this.gun) {
      this.holder.remove(this.gun.group)
      disposeBuilt(this.gun.group)
    }
    this.gun = this.models.build(idx)
    this.rebuildArms(this.gun)
    this.gun.group.add(this.arms)
    this.gun.group.scale.setScalar(idx === 0 ? 1 : VIEWMODEL_RIFLE_SCALE)
    this.gun.group.add(this.flashMesh)
    this.flashMesh.position.copy(this.gun.muzzle.position).add(new Vector3(0, 0, -0.04))
    this.holder.add(this.gun.group)
    this.weapon = idx
  }

  /** Poses the gun for the seat's current state; hides it when dead. */
  update(dt: number, p: Player, roundFrame: number, reduced: boolean): VmPose {
    this.time += dt
    if (this.weapon !== p.weapon) {
      this.swap(p.weapon)
      this.raise = 0
    }
    // A new round (frame counter at its start) raises the weapon too.
    if (roundFrame < 2) this.raise = Math.min(this.raise, 0.4)
    this.raise = Math.min(1, this.raise + dt / (reduced ? 0.08 : 0.4))
    const vm = viewmodelPose(p, { time: this.time, raise: this.raise, reduced })
    this.holder.position.set(vm.pos[0], vm.pos[1], vm.pos[2])
    this.holder.rotation.set(vm.rot[0], vm.rot[1], vm.rot[2])
    this.holder.visible = p.alive === 1
    if (this.gun?.fire && this.gun.mixer) {
      if (p.sinceShot === 0 && !reduced) this.gun.fire.reset().play()
      this.gun.mixer.update(dt)
    }
    const f = flashStrength(vm.flash, reduced)
    this.flashMesh.visible = f > 0
    ;(this.flashMesh.material as MeshBasicMaterial).opacity = f
    this.flashMesh.rotation.z = (this.time * 53) % TAU
    this.flashLight.intensity = f * 1.4
    if (this.gun) {
      // The muzzle's true place: group scale and rotation (and the holder's pose) are respected through the world matrix.
      this.camera.updateMatrixWorld(true)
      this.flashLight.position.copy(this.camera.worldToLocal(this.gun.muzzle.getWorldPosition(this.tmp)))
    }
    return vm
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      }
    })
  }
}
