import {
  AnimationClip, AnimationMixer, Box3, BufferGeometry, CanvasTexture, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Quaternion, SkinnedMesh, SphereGeometry,
  SRGBColorSpace, TorusGeometry, Vector3, type AnimationAction, type Material,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { CLIPS, requiredClips } from './animation-map'

// Two original fighters built from CC0 Quaternius rigs (Universal Base Characters, Standard) and
// the Universal Animation Library clips. Names are not stored here: the page reads them from the
// product config. Looks differ by build (height and width) and by a costume we paint ourselves into
// the base colour texture by UV region: jacket, trousers, belt, wraps and shoes, per colourway.

const BASE = '/assets/fighter/quaternius'

export interface Colorway {
  id: string
  /** Design variant name (README: Ember, Slate, Moss; Rust, Navy, Bone). */
  name: string
  jacket: number
  trousers: number
  belt: number
  /** Hand wraps and shoes. */
  trim: number
}

export interface CharacterDef {
  id: 'a' | 'b'
  asset: string
  /** Standing height in render units (1 unit = 100 sim units; the sim fighter is 1.7 tall). */
  height: number
  /** Extra width multiplier for the heavier build. */
  width: number
  /** Hair colour and whether the hair is tied back (the outfit parts below the costume paint). */
  hair: { color: number; ponytail: boolean }
  colorways: readonly Colorway[]
}

export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 'a',
    asset: 'superhero-female',
    height: 1.7,
    width: 1,
    hair: { color: 0x2a1812, ponytail: true },
    colorways: [
      { id: 'c1', name: 'Ember', jacket: 0xc4471f, trousers: 0x2b2523, belt: 0xe8b35a, trim: 0x1d1a19 },
      { id: 'c2', name: 'Slate', jacket: 0x4a5668, trousers: 0x20242b, belt: 0xb9c2cf, trim: 0x15181d },
      { id: 'c3', name: 'Moss', jacket: 0x587a3c, trousers: 0x2b2a22, belt: 0xd2c27a, trim: 0x1b1b16 },
    ],
  },
  {
    id: 'b',
    asset: 'superhero-male',
    height: 1.74,
    width: 1.12,
    hair: { color: 0x16110e, ponytail: false },
    colorways: [
      { id: 'c1', name: 'Rust', jacket: 0x8a3a1a, trousers: 0x3a2a22, belt: 0xd09a50, trim: 0x20150f },
      { id: 'c2', name: 'Navy', jacket: 0x1f3c6e, trousers: 0x15171d, belt: 0xd7d9de, trim: 0x0d0f14 },
      { id: 'c3', name: 'Bone', jacket: 0xcfc3a4, trousers: 0x4a4638, belt: 0x2a2523, trim: 0x2a2523 },
    ],
  },
]

const ARM_BONE = /^(clavicle|upperarm|lowerarm|hand)_/

export interface CharacterAssets {
  models: Map<string, Object3D>
  clips: Map<string, AnimationClip>
}

/** Splits a clip into its arm tracks and everything else, for overlay moves. */
function splitClip(clip: AnimationClip): [AnimationClip, AnimationClip] {
  const arms = clip.tracks.filter((t) => ARM_BONE.test(t.name))
  const body = clip.tracks.filter((t) => !ARM_BONE.test(t.name))
  return [new AnimationClip(clip.name + ':arms', clip.duration, arms), new AnimationClip(clip.name + ':body', clip.duration, body)]
}

export async function loadCharacterAssets(): Promise<CharacterAssets> {
  const loader = new GLTFLoader()
  const models = new Map<string, Object3D>()
  const clips = new Map<string, AnimationClip>()
  const need = new Set(requiredClips())
  const jobs: Array<Promise<void>> = []
  for (const c of CHARACTERS) {
    jobs.push(loader.loadAsync(`${BASE}/universal-base-characters/${c.asset}.glb`).then((g) => void models.set(c.asset, g.scene)))
  }
  for (const [pack, url] of [['ual1', 'universal-animation-library/ual1-combat.glb'], ['ual2', 'universal-animation-library-2/ual2-combat.glb']] as const) {
    jobs.push(
      loader.loadAsync(`${BASE}/${url}`).then((g) => {
        for (const clip of g.animations) {
          if (!need.has(clip.name) || CLIPS[clip.name]?.pack !== pack) continue
          clips.set(clip.name, clip)
          const [arms, body] = splitClip(clip)
          clips.set(arms.name, arms)
          clips.set(body.name, body)
        }
      }),
    )
  }
  await Promise.all(jobs)
  for (const name of need) if (!clips.has(name)) throw new Error(`fighter clip missing: ${name}`)
  return { models, clips }
}

export type OutfitRegion = 'skin' | 'jacket' | 'trousers' | 'belt' | 'shoes' | 'wrap'

/**
 * Which garment a body triangle belongs to, from its dominant bone and its height. `y` is the
 * triangle centre, `pelvisY` the pelvis bone and `height` the body height, all in the same space.
 * Torso and hip triangles split by height: trousers below the belt band, jacket above it.
 */
export function outfitRegion(bone: string, y: number, pelvisY: number, height: number): OutfitRegion {
  const n = bone.toLowerCase()
  if (/^(head|neck|eye|jaw)/.test(n)) return 'skin'
  if (/^(hand|thumb|index|middle|ring|pinky)/.test(n)) return 'wrap'
  if (/^(foot|ball|toe)/.test(n)) return 'shoes'
  if (/^(thigh|calf|knee)/.test(n)) return 'trousers'
  if (/^lowerarm/.test(n)) return 'skin'
  if (/^upperarm/.test(n)) return 'jacket'
  const beltLo = pelvisY - 0.005 * height
  const beltHi = pelvisY + 0.03 * height
  if (y < beltLo) return 'trousers'
  if (y < beltHi) return 'belt'
  return 'jacket'
}

/** Paints the costume into a copy of the body's base colour texture by UV triangle; skin stays as it is. */
function paintOutfit(mesh: SkinnedMesh, mat: MeshStandardMaterial, cw: Colorway): void {
  const img = mat.map?.image as { width?: number; height?: number } | undefined
  const w = img?.width
  const h = img?.height
  const geo: BufferGeometry = mesh.geometry
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  const skinIdx = geo.getAttribute('skinIndex')
  const skinW = geo.getAttribute('skinWeight')
  if (!img || !w || !h || !pos || !uv || !skinIdx || !skinW) return
  mesh.updateWorldMatrix(true, false)
  const bones = mesh.skeleton.bones
  const bw = new Vector3()
  const pelvis = bones.find((b) => b.name.toLowerCase() === 'pelvis')
  const pelvisY = pelvis ? pelvis.getWorldPosition(bw).y : 0
  const box = new Box3().setFromObject(mesh)
  const height = Math.max(0.01, box.max.y - box.min.y)
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const g = cv.getContext('2d')!
  g.drawImage(img as CanvasImageSource, 0, 0)
  g.lineJoin = 'round'
  const css: Record<OutfitRegion, string | null> = {
    skin: null,
    jacket: '#' + new Color(cw.jacket).getHexString(),
    trousers: '#' + new Color(cw.trousers).getHexString(),
    belt: '#' + new Color(cw.belt).getHexString(),
    shoes: '#' + new Color(cw.trim).getHexString(),
    wrap: '#' + new Color(cw.trim).getHexString(),
  }
  const idx = geo.getIndex()
  const tris = idx ? idx.count / 3 : pos.count / 3
  const vert = (t: number, k: number): number => (idx ? idx.getX(t * 3 + k) : t * 3 + k)
  const v = new Vector3()
  const weights = new Map<number, number>()
  for (let t = 0; t < tris; t++) {
    weights.clear()
    let cy = 0
    for (let k = 0; k < 3; k++) {
      const vi = vert(t, k)
      cy += v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld).y / 3
      for (let c = 0; c < 4; c++) {
        const wt = skinW.getComponent(vi, c)
        if (wt > 0) weights.set(skinIdx.getComponent(vi, c), (weights.get(skinIdx.getComponent(vi, c)) ?? 0) + wt)
      }
    }
    let best = -1
    let bestW = -1
    for (const [bi, wt] of weights) if (wt > bestW) { best = bi; bestW = wt }
    const region = outfitRegion(bones[best]?.name ?? 'spine_01', cy, pelvisY, height)
    const fill = css[region]
    if (!fill) continue
    g.fillStyle = fill
    g.strokeStyle = fill
    g.lineWidth = 2.5
    g.beginPath()
    for (let k = 0; k < 3; k++) {
      const vi = vert(t, k)
      const x = uv.getX(vi) * w
      const y = uv.getY(vi) * h
      if (k === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.closePath()
    g.fill()
    g.stroke()
  }
  const tex = new CanvasTexture(cv)
  tex.flipY = false
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  mat.map = tex
  mat.needsUpdate = true
}

const darken = (hex: number, k: number): number => new Color(hex).multiplyScalar(k).getHex()

/**
 * Real geometry on top of the painted costume (tinderbox-r2: the rigs looked like bald base mannequins): hair, a headband,
 * forearm gauntlets with cuffs, shoulder pauldrons and knee guards. Parts are built in the model's bind pose (T pose, +Z
 * forward, metres, before the rig is scaled) and attached to their bones with `attach`, which keeps the world transform,
 * so they follow the animation. Returns the names of the parts it added. The model must already be in world space.
 */
export function addOutfitParts(model: Object3D, def: CharacterDef, cw: Colorway, own: Array<{ dispose(): void }>): string[] {
  model.updateMatrixWorld(true)
  const added: string[] = []
  const bones = new Map<string, Object3D>()
  model.traverse((o) => {
    if ((o as { isBone?: boolean }).isBone) bones.set(o.name.toLowerCase(), o) // the head bone is "Head", the rest lower case
  })
  const bone = (n: string): Object3D | undefined => bones.get(n.toLowerCase())
  const wp = (o: Object3D): Vector3 => o.getWorldPosition(new Vector3())
  const mat = (color: number, metalness: number, roughness: number): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ color, metalness, roughness })
    own.push(m)
    return m
  }
  const put = (name: string, host: string, geo: BufferGeometry, m: MeshStandardMaterial, pos: Vector3, quat?: Quaternion, scale?: Vector3): void => {
    const b = bone(host)
    if (!b) return
    own.push(geo)
    const mesh = new Mesh(geo, m)
    mesh.name = `outfit:${name}`
    mesh.position.copy(pos)
    if (quat) mesh.quaternion.copy(quat)
    if (scale) mesh.scale.copy(scale)
    mesh.castShadow = true
    mesh.frustumCulled = false
    model.add(mesh)
    mesh.updateMatrixWorld(true)
    b.attach(mesh)
    added.push(mesh.name)
  }
  const Y = new Vector3(0, 1, 0)
  const trim = mat(cw.trim, 0.2, 0.75)
  const metal = mat(cw.belt, 0.7, 0.35)
  const pad = mat(darken(cw.jacket, 0.5), 0.3, 0.55)
  const hair = mat(def.hair.color, 0.05, 0.85)

  // Head: eyes sit at about 0.94 of the body height; the head centre is a little above and behind them.
  const eyes = model.getObjectByName('Eyes')
  const eyeBox = eyes ? new Box3().setFromObject(eyes) : null
  const eyeY = eyeBox ? (eyeBox.min.y + eyeBox.max.y) / 2 : 1.69
  const head = new Vector3(0, eyeY + 0.005, eyeBox ? eyeBox.max.z - 0.1 : -0.02)
  put('hair', 'head', new SphereGeometry(0.1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.42), hair, head.clone(), undefined, new Vector3(1.02, 1.1, 1.1))
  put('headband', 'head', new TorusGeometry(0.088, 0.011, 8, 28), metal, head.clone().add(new Vector3(0, 0.03, 0)), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2), new Vector3(1, 1.04, 1))
  if (def.hair.ponytail) {
    put('ponytail', 'head', new CylinderGeometry(0.03, 0.012, 0.26, 10), hair, head.clone().add(new Vector3(0, -0.06, -0.12)), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.28))
  }
  // Arms and legs, per side.
  for (const side of ['l', 'r'] as const) {
    const sign = side === 'l' ? 1 : -1
    const upper = bone(`upperarm_${side}`)
    const lower = bone(`lowerarm_${side}`)
    const hand = bone(`hand_${side}`)
    const calf = bone(`calf_${side}`)
    if (upper) put(`pauldron_${side}`, `upperarm_${side}`, new SphereGeometry(0.072, 16, 12), pad, wp(upper).add(new Vector3(-0.03 * sign, 0.03, 0)), undefined, new Vector3(1.1, 0.7, 0.95))
    if (lower && hand) {
      const a = wp(lower)
      const b = wp(hand)
      const dir = b.clone().sub(a)
      const len = dir.length()
      const q = new Quaternion().setFromUnitVectors(Y, dir.clone().normalize())
      put(`gauntlet_${side}`, `lowerarm_${side}`, new CylinderGeometry(0.047, 0.04, len * 0.52, 12), trim, a.clone().addScaledVector(dir, 0.46), q)
      put(`cuff_${side}`, `lowerarm_${side}`, new CylinderGeometry(0.054, 0.054, 0.028, 14), metal, a.clone().addScaledVector(dir, 0.2), q)
    }
    if (calf) {
      const k = wp(calf)
      put(`kneeguard_${side}`, `calf_${side}`, new SphereGeometry(0.055, 14, 10), trim, k.clone().add(new Vector3(0, 0.02, 0.05)), undefined, new Vector3(1, 1.25, 0.55))
    }
  }
  return added
}

export interface PoseEntry {
  clip: string
  time: number
  weight: number
}

export class FighterRig {
  readonly root = new Group()
  /** The scaled, turned model inside `root`. */
  readonly model: Object3D
  private readonly mixer: AnimationMixer
  private readonly actions = new Map<string, AnimationAction>()
  private readonly owned: Array<{ dispose(): void }> = []

  constructor(def: CharacterDef, colorway: Colorway, assets: CharacterAssets) {
    const src = assets.models.get(def.asset)
    if (!src) throw new Error(`character model missing: ${def.asset}`)
    this.model = cloneSkinned(src)
    this.model.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = false
      m.frustumCulled = false
      const own = (Array.isArray(m.material) ? m.material : [m.material]).map((mat: Material) => {
        const c = mat.clone() as MeshStandardMaterial
        this.owned.push(c)
        return c
      })
      m.material = Array.isArray(m.material) ? own : own[0]!
      if (!(m as SkinnedMesh).isSkinnedMesh) return
      for (const mat of own) if (mat.name.startsWith('MI_Superhero')) paintOutfit(m as SkinnedMesh, mat, colorway)
    })
    addOutfitParts(this.model, def, colorway, this.owned)
    // Normalise the standing height from the bind pose.
    const box = new Box3()
    const v = new Vector3()
    this.model.updateMatrixWorld(true)
    this.model.traverse((o) => {
      const s = o as SkinnedMesh
      if (s.isSkinnedMesh) {
        s.computeBoundingBox()
        box.union(s.boundingBox!.clone().applyMatrix4(s.matrixWorld))
      }
    })
    box.getSize(v)
    const k = def.height / Math.max(0.01, v.y)
    this.model.scale.set(k * def.width, k, k * def.width)
    this.root.add(this.model)
    this.mixer = new AnimationMixer(this.model)
    this.assets = assets
  }

  private readonly assets: CharacterAssets

  private action(name: string): AnimationAction {
    let a = this.actions.get(name)
    if (!a) {
      a = this.mixer.clipAction(this.assets.clips.get(name)!)
      a.play()
      a.setEffectiveWeight(0)
      this.actions.set(name, a)
    }
    return a
  }

  /** Creates every clip's action now (binding the tracks costs a few milliseconds each), so no move hitches the first time it plays. */
  warm(names: Iterable<string>): void {
    for (const n of names) if (this.assets.clips.has(n)) this.action(n)
  }

  /** Poses the skeleton exactly at the given clip times (no playback). Weights should cover every bone once. */
  pose(entries: readonly PoseEntry[]): void {
    for (const a of this.actions.values()) a.setEffectiveWeight(0)
    for (const e of entries) {
      const a = this.action(e.clip)
      const dur = a.getClip().duration
      a.time = Math.max(0, Math.min(dur - 1e-4, e.time))
      a.setEffectiveWeight(e.weight)
    }
    this.mixer.update(0)
  }

  dispose(): void {
    this.mixer.stopAllAction()
    for (const o of this.owned) {
      const m = o as MeshStandardMaterial
      m.map?.dispose()
      o.dispose()
    }
  }
}
