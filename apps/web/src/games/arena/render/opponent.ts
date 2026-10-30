import {
  AnimationAction, AnimationClip, AnimationMixer, Box3, BufferGeometry, CanvasTexture, Color, Group, LoopOnce, LoopRepeat, Mesh, MeshStandardMaterial, Object3D,
  Matrix4, Quaternion, SkinnedMesh, SRGBColorSpace, Vector3,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { EV, type Player } from '@duelwise/core/src/games/arena/state.ts'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons.ts'
import { outfitRegion, type OutfitRegion } from '../../fighter/render/characters'
import { paidAssetUrl } from '../../../lib/paid-assets'
import { twoBoneIK } from './ik'
import { modelYaw, toScene, UNIT, unitsToRad } from './camera'
import { disposeBuilt, type WeaponModels } from './viewmodel'

// The other player, in third person from your eyes: the CC0 Quaternius Universal Base Characters
// rig with the Universal Animation Library clips (pistol stance, jog, crouch, death). The pose is a
// pure function of sim state (opponentBase), so the same state always draws the same stance.

const CHAR_URL = '/assets/arena/quaternius/universal-base-characters/superhero-male.glb'
/** Paid UAL1 clips (not in the public repo): loaded from the paid base, see lib/paid-assets.ts. */
export const PAID_CLIPS_PATH = 'arena/quaternius/universal-animation-library/ual1-shooter.glb'
/** Free Standard clips, used when the paid file cannot be fetched. */
const FREE_CLIPS_URL = '/assets/fighter/quaternius/universal-animation-library/ual1-combat.glb'
/** Which free clip stands in for each paid base clip when the paid file is missing. */
const FREE_STAND_IN: Record<string, string> = {
  Pistol_Aim_Neutral: 'Idle_Loop',
  Jog_Fwd_Loop: 'Sprint_Loop',
  Jog_Bwd_Loop: 'Walk_Loop',
  Jog_Left_Loop: 'Sprint_Loop',
  Jog_Right_Loop: 'Sprint_Loop',
  Crouch_Bwd_Loop: 'Crouch_Fwd_Loop',
  Crouch_Left_Loop: 'Crouch_Fwd_Loop',
  Crouch_Right_Loop: 'Crouch_Fwd_Loop',
  Death02: 'Death01',
}
/** Standing height in metres: the sim hull is 72 units. */
const HEIGHT = 72 * UNIT

export type BaseClip =
  | 'Pistol_Aim_Neutral' | 'Walk_Loop' | 'Jog_Fwd_Loop' | 'Jog_Bwd_Loop' | 'Jog_Left_Loop' | 'Jog_Right_Loop'
  | 'Crouch_Idle_Loop' | 'Crouch_Fwd_Loop' | 'Crouch_Bwd_Loop' | 'Crouch_Left_Loop' | 'Crouch_Right_Loop'
  | 'Jump_Loop' | 'Death01' | 'Death02'

/** The looping base clip for a seat, from its velocity relative to where it faces. */
export function opponentBase(p: Player, headshotDeath = false): BaseClip {
  if (p.alive === 0) return headshotDeath ? 'Death02' : 'Death01'
  if (p.onGround === 0) return 'Jump_Loop'
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
  const top = WEAPONS[p.weapon]!.maxSpeed
  if (speed < 18) return p.crouch === 1 ? 'Crouch_Idle_Loop' : 'Pistol_Aim_Neutral'
  // Velocity in the seat's own frame: forward = (cos yaw, sin yaw), right = (sin yaw, -cos yaw).
  const yaw = unitsToRad(p.yaw)
  const fwd = p.vx * Math.cos(yaw) + p.vy * Math.sin(yaw)
  const side = p.vx * Math.sin(yaw) - p.vy * Math.cos(yaw)
  const dir: 'Fwd' | 'Bwd' | 'Left' | 'Right' = Math.abs(fwd) >= Math.abs(side) ? (fwd >= 0 ? 'Fwd' : 'Bwd') : side >= 0 ? 'Right' : 'Left'
  if (p.crouch === 1) return `Crouch_${dir}_Loop` as BaseClip
  if (speed < top * 0.6 && dir === 'Fwd') return 'Walk_Loop'
  return `Jog_${dir}_Loop` as BaseClip
}

/** Half angle of the cone in front of the body inside which the gun is allowed to track the player's eye. */
export const EYE_CONE = (65 * Math.PI) / 180

/** Half width of the blend band around EYE_CONE: full eye tracking inside the inner edge, full sim aim outside the outer edge. */
export const EYE_BAND = (15 * Math.PI) / 180

/**
 * The unit direction the opponent's arms and gun should point. Inside the cone in front of the body it
 * is the direction to the eye (a bot that aims at you points at you); outside it is the sim's own aim
 * (yaw and pitch), so a turned back never gets a gun swung at the camera. Across a band around the cone
 * edge the two are blended by `w` (1 = at the eye, 0 = sim aim), so one unit of yaw never pops the pose.
 * `sim` is the pure sim aim, for callers that blend a different eye vector (hand to eye) by the same `w`.
 */
export function aimDirection(from: Vector3, eye: Vector3, yawUnits: number, pitchUnits: number): { dir: Vector3; sim: Vector3; w: number } {
  const yaw = unitsToRad(yawUnits)
  const pitch = unitsToRad(pitchUnits)
  // Scene facing on the floor: sim (cos yaw, sin yaw) maps to (cos yaw, -sin yaw).
  const fx = Math.cos(yaw)
  const fz = -Math.sin(yaw)
  const to = eye.clone().sub(from)
  const flat = Math.hypot(to.x, to.z)
  const cos = flat < 1e-6 ? 1 : (to.x * fx + to.z * fz) / flat
  const angle = Math.acos(Math.max(-1, Math.min(1, cos)))
  const t = Math.max(0, Math.min(1, (EYE_CONE + EYE_BAND - angle) / (2 * EYE_BAND)))
  const w = t * t * (3 - 2 * t)
  const c = Math.cos(pitch)
  const sim = new Vector3(fx * c, Math.sin(pitch), fz * c).normalize()
  const eyeDir = to.normalize()
  return { dir: sim.clone().lerp(eyeDir, w).normalize(), sim, w }
}

export interface OpponentAssets {
  character: Group
  clips: Map<string, AnimationClip>
}

type LoadGltf = (url: string) => Promise<{ scene: Group; animations: AnimationClip[] }>

/**
 * The opponent's rig and clips. The paid clip file loads from the paid base; if that fetch fails the
 * free Standard clips fill in (stand-ins named as the paid clips, so the pose code does not change).
 */
export async function loadOpponentAssets(load: LoadGltf = (u) => new GLTFLoader().loadAsync(u), paidBase: string | undefined = import.meta.env?.VITE_PAID_ASSETS_URL): Promise<OpponentAssets> {
  const [c, paid] = await Promise.all([load(CHAR_URL), paidBase?.trim() ? load(paidAssetUrl(PAID_CLIPS_PATH, paidBase)).catch(() => null) : Promise.resolve(null)])
  const clips = new Map<string, AnimationClip>()
  if (paid && paid.animations.length) {
    for (const clip of paid.animations) clips.set(clip.name, clip)
    return { character: c.scene, clips }
  }
  const free = await load(FREE_CLIPS_URL)
  for (const clip of free.animations) clips.set(clip.name, clip)
  for (const [want, have] of Object.entries(FREE_STAND_IN)) {
    const clip = clips.get(have)
    // A clone, so two stand-ins never share one mixer action (a cross fade from itself would silence the pose).
    if (clip) clips.set(want, clip.clone())
  }
  return { character: c.scene, clips }
}

/** Dark tactical colours, so the opponent reads as a body against the lit door and the pale walls. */
const SUIT: Record<OutfitRegion, string | null> = {
  skin: null,
  jacket: '#262c34',
  trousers: '#1b1e23',
  belt: '#3a3126',
  shoes: '#0f1113',
  wrap: '#121416',
}

/** Paints the suit into a copy of the body's base colour texture by UV triangle (same method as the fighter outfits); skin stays. */
function paintSuit(mesh: SkinnedMesh, mat: MeshStandardMaterial): void {
  const img = mat.map?.image as { width?: number; height?: number } | undefined
  const w = img?.width
  const h = img?.height
  const geo: BufferGeometry = mesh.geometry
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  const skinIdx = geo.getAttribute('skinIndex')
  const skinW = geo.getAttribute('skinWeight')
  if (!img || !w || !h || !pos || !uv || !skinIdx || !skinW) return
  mesh.updateWorldMatrix(true, true)
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
    const fill = SUIT[outfitRegion(bones[best]?.name ?? 'spine_01', cy, pelvisY, height)]
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

const OVERLAY_FADE = 0.06

export class Opponent {
  readonly root = new Group()
  private model: Object3D
  private mixer: AnimationMixer
  private actions = new Map<string, AnimationAction>()
  private current: AnimationAction | null = null
  private currentName = ''
  private gun: Group | null = null
  private gunWeapon = -1
  private hand: Object3D | null
  private headshotDeath = false
  private lastAlive = true

  constructor(private readonly assets: OpponentAssets, private readonly models: WeaponModels) {
    this.model = cloneSkinned(assets.character)
    const box = new Box3().setFromObject(this.model)
    const h = box.getSize(new Vector3()).y || 1.8
    const s = HEIGHT / h
    this.model.scale.multiplyScalar(s)
    this.model.updateMatrixWorld(true)
    const feet = new Box3().setFromObject(this.model).min.y
    this.model.position.y -= feet
    this.model.traverse((o) => {
      const m = o as SkinnedMesh
      if (!m.isMesh) return
      m.castShadow = true
      m.frustumCulled = false
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      const next = mats.map((mat) => {
        const c = (mat as MeshStandardMaterial).clone()
        c.color = new Color(0xffffff)
        c.roughness = 0.8
        if (m.isSkinnedMesh) paintSuit(m, c)
        return c
      })
      m.material = Array.isArray(m.material) ? next : next[0]!
    })
    this.root.add(this.model)
    this.mixer = new AnimationMixer(this.model)
    this.hand = this.model.getObjectByName('hand_r') ?? null
  }

  private action(name: string): AnimationAction | null {
    let a = this.actions.get(name) ?? null
    if (a) return a
    const clip = this.assets.clips.get(name)
    if (!clip) return null
    a = this.mixer.clipAction(clip)
    this.actions.set(name, a)
    return a
  }

  private setBase(name: BaseClip, instant: boolean): void {
    if (name === this.currentName) return
    const next = this.action(name)
    if (!next) return
    const dead = name.startsWith('Death')
    next.setLoop(dead ? LoopOnce : LoopRepeat, dead ? 1 : Infinity)
    next.clampWhenFinished = dead
    next.reset().setEffectiveWeight(1).play()
    if (this.current && !instant) next.crossFadeFrom(this.current, dead ? 0.1 : 0.14, false)
    else if (this.current) this.current.stop()
    this.current = next
    this.currentName = name
    if (!dead) next.time = (next.time + 0.001) % Math.max(0.01, next.getClip().duration)
  }

  private overlay(name: string, weight: number): void {
    const a = this.action(name)
    if (!a) return
    a.setLoop(LoopOnce, 1)
    a.clampWhenFinished = false
    a.reset().setEffectiveWeight(weight).fadeIn(OVERLAY_FADE).play()
    a.fadeOut(Math.max(0.1, a.getClip().duration - OVERLAY_FADE))
  }

  /** Per sim step: one-shot reactions from the seat's events. */
  onStep(p: Player): void {
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
    if (p.events & EV.DIED && p.events & EV.HEADSHOT) this.headshotDeath = true
    if (speed < 40 && p.alive === 1) {
      if (p.events & EV.FIRED) this.overlay('Pistol_Shoot', 1)
      else if (p.events & EV.RELOAD) this.overlay('Pistol_Reload', 1)
    }
  }


  /** Hit reaction when you hit the opponent; the shooter's HEADSHOT bit picks the head flinch. */
  onHit(head: boolean, victimAlive: boolean): void {
    if (victimAlive) this.overlay(head ? 'Hit_Head' : 'Hit_Chest', 0.5)
  }

  /** Marks a headshot kill so the right death plays (the killer's event arrives on the other seat). */
  noteHeadshotKill(): void {
    this.headshotDeath = true
  }

  update(dt: number, prev: Player, next: Player, alpha: number, jumped: boolean, eye?: Vector3): void {
    const a = Math.min(1, Math.max(0, alpha))
    const lerp = (x: number, y: number): number => x + (y - x) * a
    const [sx, sy, sz] = toScene(lerp(prev.x, next.x), lerp(prev.y, next.y), lerp(prev.z, next.z))
    this.root.position.set(sx, sy, sz)
    // Face the aim yaw, taking the short way round the wrap.
    let dy = unitsToRad(next.yaw - prev.yaw)
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.root.rotation.y = modelYaw(next.yaw) - dy * (1 - a)
    if (next.alive === 1 && !this.lastAlive) {
      this.headshotDeath = false
      this.currentName = ''
    }
    this.lastAlive = next.alive === 1
    this.setBase(opponentBase(next, this.headshotDeath), jumped)
    this.mixer.update(dt)
    this.syncGun(next)
    if (eye && next.alive === 1) this.aimArms(eye, next)
    this.root.visible = true
  }

  private syncGun(p: Player): void {
    if (!this.hand || p.alive === 0 && !this.gun) return
    if (this.gunWeapon !== p.weapon) {
      if (this.gun) {
        this.hand.remove(this.gun)
        disposeBuilt(this.gun)
      }
      const built = this.models.build(p.weapon, false)
      this.gripDrop = built.gripDrop
      this.gun = built.group
      this.alignGun(this.gun)
      this.hand.add(this.gun)
      this.gunWeapon = p.weapon
    }
    if (this.gun) this.gun.visible = p.alive === 1
  }

  /** Shoulders, chest and pelvis in world metres (the torso's corners for the screen space probe); empty when the rig lacks the bones. */
  torsoPoints(): Vector3[] {
    this.model.updateWorldMatrix(true, true)
    const out: Vector3[] = []
    for (const n of ['upperarm_l', 'upperarm_r', 'spine_02', 'pelvis']) {
      const o = this.model.getObjectByName(n)
      if (o) out.push(o.getWorldPosition(new Vector3()))
    }
    return out.length === 4 ? out : []
  }

  private gripDrop = 0
  private bones: { ur: Object3D; lr: Object3D; hr: Object3D; ul: Object3D; ll: Object3D; hl: Object3D; spine: Object3D } | null | undefined

  /** Points the gun at `eye` while it is in front of the body, else along the sim aim; the left hand joins on the gun. */
  private aimArms(eye: Vector3, p: Player): void {
    if (this.bones === undefined) {
      const g = (n: string): Object3D | undefined => this.model.getObjectByName(n)
      const [ur, lr, hr, ul, ll, hl, spine] = ['upperarm_r', 'lowerarm_r', 'hand_r', 'upperarm_l', 'lowerarm_l', 'hand_l', 'spine_02'].map(g)
      this.bones = ur && lr && hr && ul && ll && hl && spine ? { ur, lr, hr, ul, ll, hl, spine } : null
    }
    const b = this.bones
    if (!b) return
    this.model.updateWorldMatrix(true, true)
    const sh = b.ur.getWorldPosition(new Vector3())
    const chest = b.spine.getWorldPosition(new Vector3())
    const aim = aimDirection(sh, eye, p.yaw, p.pitch)
    const dir = aim.dir.clone()
    dir.y = Math.max(-0.35, Math.min(0.35, dir.y / Math.max(1e-3, Math.hypot(dir.x, dir.z))))
    const flat = Math.hypot(dir.x, dir.z) || 1
    dir.set(dir.x / flat, dir.y, dir.z / flat).normalize()
    const side = sh.clone().sub(chest)
    side.y = 0
    side.normalize()
    const target = sh.clone().addScaledVector(dir, 0.56)
    twoBoneIK(b.ur, b.lr, b.hr, target, sh.clone().addScaledVector(side, 0.35).add(new Vector3(0, -0.5, 0)))
    this.model.updateWorldMatrix(true, true)
    // The barrel runs through the gun's origin, not the wrist, so the eye direction is taken from the origin; turning the
    // hand moves the origin a little, so a few passes settle it.
    const origin = new Vector3()
    for (let pass = 0; pass < 4; pass++) {
      if (this.gun) this.gun.getWorldPosition(origin)
      else b.hr.getWorldPosition(origin)
      this.faceGun(b.hr, aim.sim.clone().lerp(eye.clone().sub(origin).normalize(), aim.w).normalize())
    }
    this.measureBarrel(eye, aim.w)
    const hand = b.hr.getWorldPosition(new Vector3())
    const shl = b.ul.getWorldPosition(new Vector3())
    const tl = hand.clone().addScaledVector(dir, 0.1).add(new Vector3(0, -0.015, 0))
    twoBoneIK(b.ul, b.ll, b.hl, tl, shl.clone().addScaledVector(side, -0.35).add(new Vector3(0, -0.5, 0)))
  }

  /** How far the barrel line passes from the eye (metres) and the eye weight of the aim, last aimed frame. For the replay check. */
  barrel: { miss: number; w: number; weapon: number } | null = null

  private measureBarrel(eye: Vector3, w: number): void {
    if (!this.gun) return
    const o = this.gun.getWorldPosition(new Vector3())
    const d = new Vector3(0, 0, -1).transformDirection(this.gun.matrixWorld)
    const toEye = eye.clone().sub(o)
    this.barrel = { miss: toEye.sub(d.multiplyScalar(toEye.dot(d))).length(), w, weapon: this.gunWeapon }
  }

  /** Turns the right hand so the gun's barrel (its local -z) points along the unit direction `want`. */
  private faceGun(hr: Object3D, want: Vector3): void {
    if (!this.gun) return
    this.model.updateWorldMatrix(true, true)
    const cur = new Vector3(0, 0, -1).transformDirection(this.gun.matrixWorld)
    const delta = new Quaternion().setFromUnitVectors(cur, want)
    const handQ = hr.getWorldQuaternion(new Quaternion())
    const parentQ = (hr.parent as Object3D).getWorldQuaternion(new Quaternion())
    hr.quaternion.copy(parentQ.invert().multiply(delta.multiply(handQ)))
    this.model.updateWorldMatrix(true, true)
  }

  /**
   * Holds the gun the way a hand holds a pistol: the barrel runs along the fingers, the top of the
   * gun faces the thumb, and the grip sits in the middle of the palm. Worked out from the hand's own
   * finger bones, so it does not depend on how the rig orients its bones.
   */
  private alignGun(gun: Group): void {
    const finger = this.model.getObjectByName('middle_01_r')
    const thumb = this.model.getObjectByName('thumb_01_r')
    const inv = 1 / this.model.scale.x
    gun.scale.setScalar(inv)
    if (!finger || !thumb) return
    // The barrel runs along the forearm: the hand's offset in the lower arm's frame, brought into the hand's own frame.
    const hand = this.hand!
    const d = hand.position.clone().normalize().applyQuaternion(hand.quaternion.clone().invert())
    // Thumb direction with the part along the fingers removed.
    const u = thumb.position.clone()
    u.addScaledVector(d, -u.dot(d)).normalize()
    const zAxis = d.clone().negate()
    const xAxis = new Vector3().crossVectors(u, zAxis).normalize()
    const m = new Matrix4().makeBasis(xAxis, u, zAxis)
    gun.quaternion.setFromRotationMatrix(m)
    gun.position.copy(finger.position).multiplyScalar(0.6)
    // Long guns have their origin on the barrel axis, so the palm sits `gripDrop` below it.
    if (this.gripDrop > 0) gun.position.add(new Vector3(0, this.gripDrop * inv, 0).applyQuaternion(gun.quaternion))
  }

  /** Where the opponent's muzzle is, in scene metres (for audio and tracers). */
  muzzleWorld(out: Vector3): Vector3 {
    if (this.gun) return this.gun.getWorldPosition(out)
    return out.copy(this.root.position)
  }

  dispose(): void {
    this.mixer.stopAllAction()
    this.root.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) {
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      }
    })
  }
}
