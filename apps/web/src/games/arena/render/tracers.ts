import {
  AdditiveBlending, BufferGeometry, CanvasTexture, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Points, PointsMaterial, Vector3,
  Line, LineBasicMaterial, SRGBColorSpace,
} from 'three'
import type { MapData } from '@duelwise/core/src/games/arena/map.ts'
import type { Player } from '@duelwise/core/src/games/arena/state.ts'
import { eyeHeight, HULL_HALF, hullHeight } from '@duelwise/core/src/games/arena/movement.ts'
import { toScene, unitsToRad } from './camera'

// Shot visuals: a tracer from the muzzle to where the bullet stops, a bullet decal on the wall, sparks
// on metal and a red puff on the opponent. The sim does not export the exact shot (its spread comes
// from the shared Rng), so the visual follows the aim ray with the weapon punch, which is where the
// bullet goes up to the spread. A hit that the sim reports (HIT_DEALT) always ends on the opponent.

export interface RayHit {
  /** Distance in sim units. */
  t: number
  /** Surface normal in sim axes (x, y, z up). */
  nx: number
  ny: number
  nz: number
  /** Index of the box that was hit, -1 for the floor, -2 for the ceiling. */
  box: number
}

/** Aim direction in sim axes (z up) for a player: view angles plus the weapon punch. Uses Math trig; for drawing only. */
export function aimDir(p: Player): [number, number, number] {
  const yaw = unitsToRad(p.yaw + p.punchYaw)
  const pitch = unitsToRad(Math.max(-2048, Math.min(2048, p.pitch + Math.round(p.punchPitch))))
  const cp = Math.cos(pitch)
  return [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)]
}

/** Slab test of one box. Returns the entry distance and the entry face normal, or null. */
function slab(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  b: ArrayLike<number>, o: number, maxT: number,
): { t: number; nx: number; ny: number; nz: number } | null {
  let tmin = 0
  let tmax = maxT
  let nx = 0
  let ny = 0
  let nz = 0
  const org = [ox, oy, oz]
  const dir = [dx, dy, dz]
  for (let a = 0; a < 3; a++) {
    const lo = b[o + a]!
    const hi = b[o + 3 + a]!
    const d = dir[a]!
    const p = org[a]!
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return null
      continue
    }
    let t1 = (lo - p) / d
    let t2 = (hi - p) / d
    let sign = -1
    if (t1 > t2) {
      const s = t1
      t1 = t2
      t2 = s
      sign = 1
    }
    if (t1 > tmin) {
      tmin = t1
      nx = a === 0 ? sign : 0
      ny = a === 1 ? sign : 0
      nz = a === 2 ? sign : 0
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }
  if (tmin <= 0) return null
  return { t: tmin, nx, ny, nz }
}

/** The nearest surface along a ray: boxes, the floor (z = 0) and the ceiling (z = wallHeight). Null if nothing within maxT. */
export function rayBoxes(map: MapData, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT = 8192): RayHit | null {
  let best: RayHit | null = null
  for (let i = 0; i < map.boxCount; i++) {
    const h = slab(ox, oy, oz, dx, dy, dz, map.boxes, i * 6, best ? best.t : maxT)
    if (h && (!best || h.t < best.t)) best = { ...h, box: i }
  }
  if (dz < -1e-9) {
    const t = -oz / dz
    if (t > 0 && t < (best ? best.t : maxT)) best = { t, nx: 0, ny: 0, nz: 1, box: -1 }
  } else if (dz > 1e-9) {
    const t = (map.wallHeight - oz) / dz
    if (t > 0 && t < (best ? best.t : maxT)) best = { t, nx: 0, ny: 0, nz: -1, box: -2 }
  }
  return best
}

/** Distance along a ray to a player's hull box, or -1. */
export function rayHull(q: Player, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT = 8192): number {
  const hq = hullHeight(q)
  const box = [q.x - HULL_HALF, q.y - HULL_HALF, q.z, q.x + HULL_HALF, q.y + HULL_HALF, q.z + hq]
  const h = slab(ox, oy, oz, dx, dy, dz, box, 0, maxT)
  return h ? h.t : -1
}

export interface ShotVisual {
  /** Scene metres. */
  from: Vector3
  to: Vector3
  /** What the bullet ended on. */
  end: 'wall' | 'player'
  /** Surface normal in scene axes (for a decal). */
  normal: Vector3
  box: number
}

/**
 * Works out where a seat's shot ended. `muzzleOffset` is the muzzle's offset from the eye in sim units
 * along (forward, right, down). Hits the opponent when the sim reported HIT_DEALT, otherwise the wall.
 */
export function shotVisual(map: MapData, shooter: Player, target: Player, hitTarget: boolean, muzzle: [number, number, number]): ShotVisual {
  const [dx, dy, dz] = aimDir(shooter)
  const ox = shooter.x
  const oy = shooter.y
  const oz = shooter.z + eyeHeight(shooter)
  // Offsets: forward along the aim, right = (sin yaw, -cos yaw), down = -z.
  const yaw = unitsToRad(shooter.yaw)
  const rx = Math.sin(yaw)
  const ry = -Math.cos(yaw)
  const mx = ox + dx * muzzle[0] + rx * muzzle[1]
  const my = oy + dy * muzzle[0] + ry * muzzle[1]
  const mz = oz + dz * muzzle[0] - muzzle[2]
  const wall = rayBoxes(map, ox, oy, oz, dx, dy, dz)
  const tWall = wall ? wall.t : 8192
  let tHull = rayHull(target, ox, oy, oz, dx, dy, dz, tWall)
  let end: 'wall' | 'player' = 'wall'
  let t = tWall
  let n: [number, number, number] = wall ? [wall.nx, wall.ny, wall.nz] : [0, 0, 1]
  if (tHull > 0 && tHull < tWall) {
    end = 'player'
    t = tHull
    n = [-dx, -dy, -dz]
  } else if (hitTarget) {
    // The sim says it hit; spread put the exact ray off the hull, so end on the chest.
    end = 'player'
    tHull = Math.sqrt((target.x - ox) ** 2 + (target.y - oy) ** 2 + (target.z + hullHeight(target) * 0.64 - oz) ** 2)
    t = tHull
    n = [-dx, -dy, -dz]
  }
  const from = new Vector3(...toScene(mx, my, mz))
  let to: Vector3
  if (end === 'player' && hitTarget && !(rayHull(target, ox, oy, oz, dx, dy, dz, tWall) > 0)) {
    to = new Vector3(...toScene(target.x, target.y, target.z + hullHeight(target) * 0.64))
  } else {
    to = new Vector3(...toScene(ox + dx * t, oy + dy * t, oz + dz * t))
  }
  return { from, to, end, normal: new Vector3(n[0], n[2], -n[1]), box: wall ? wall.box : -3 }
}

// ---------------------------------------------------------------- pools

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.4, 'rgba(255,255,255,0.5)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 32, 32)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}

function decalTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 30)
  grd.addColorStop(0, 'rgba(8,8,8,0.95)')
  grd.addColorStop(0.28, 'rgba(14,14,14,0.85)')
  grd.addColorStop(0.5, 'rgba(30,30,30,0.35)')
  grd.addColorStop(1, 'rgba(30,30,30,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 64, 64)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}

interface Tracer {
  line: Line
  life: number
  total: number
}

interface Decal {
  mesh: Mesh
  age: number
}

const MAX_DECALS = 80
const DECAL_LIFE = 12
const MAX_TRACERS = 16
const MAX_SPARKS = 160

/** Tracers, decals and sparks, all pooled so a long match allocates nothing per shot. */
export class ShotEffects {
  readonly group = new Group()
  private tracers: Tracer[] = []
  private decals: Decal[] = []
  private decalNext = 0
  private decalGeo = new PlaneGeometry(0.16, 0.16)
  private decalMat = new MeshBasicMaterial({ map: decalTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
  private sparkPos: Float32Array<ArrayBufferLike> = new Float32Array(MAX_SPARKS * 3)
  private sparkVel = new Float32Array(MAX_SPARKS * 3)
  private sparkLife = new Float32Array(MAX_SPARKS)
  private sparkColor: Float32Array<ArrayBufferLike> = new Float32Array(MAX_SPARKS * 3)
  private sparkNext = 0
  private sparks: Points
  private glow = glowTexture()

  constructor() {
    for (let i = 0; i < MAX_TRACERS; i++) {
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(6, 3))
      const l = new Line(g, new LineBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false, toneMapped: false }))
      l.visible = false
      l.frustumCulled = false
      this.group.add(l)
      this.tracers.push({ line: l, life: 0, total: 0.001 })
    }
    for (let i = 0; i < MAX_DECALS; i++) {
      const m = new Mesh(this.decalGeo, this.decalMat)
      m.visible = false
      this.group.add(m)
      this.decals.push({ mesh: m, age: 0 })
    }
    const sg = new BufferGeometry()
    const pa = new Float32BufferAttribute(this.sparkPos, 3)
    const ca = new Float32BufferAttribute(this.sparkColor, 3)
    sg.setAttribute('position', pa)
    sg.setAttribute('color', ca)
    // The attributes copy their input; write through their own arrays from here on.
    this.sparkPos = pa.array as Float32Array<ArrayBufferLike>
    this.sparkColor = ca.array as Float32Array<ArrayBufferLike>
    this.sparks = new Points(sg, new PointsMaterial({
      size: 0.05, map: this.glow, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, sizeAttenuation: true,
    }))
    this.sparks.frustumCulled = false
    this.group.add(this.sparks)
  }

  tracer(v: ShotVisual, fromPlayer: boolean): void {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0]!
    t.life = t.total = fromPlayer ? 0.06 : 0.09
    const a = t.line.geometry.getAttribute('position')
    a.setXYZ(0, v.from.x, v.from.y, v.from.z)
    a.setXYZ(1, v.to.x, v.to.y, v.to.z)
    a.needsUpdate = true
    t.line.visible = true
  }

  /** A bullet hole and a few sparks where a shot struck a wall. */
  impact(v: ShotVisual): void {
    if (v.end === 'wall') {
      const d = this.decals[this.decalNext++ % MAX_DECALS]!
      d.age = 0
      d.mesh.visible = true
      const sc = 0.7 + ((this.decalNext * 37) % 10) / 20
      d.mesh.scale.setScalar(sc)
      d.mesh.position.copy(v.to).addScaledVector(v.normal, 0.004)
      d.mesh.lookAt(v.to.clone().add(v.normal))
      d.mesh.rotateZ(((this.decalNext * 53) % 100) / 16)
      this.burst(v.to, v.normal, 7, [1, 0.8, 0.45], 1.8)
    } else {
      this.burst(v.to, v.normal, 9, [0.85, 0.05, 0.04], 1.1)
    }
  }

  private burst(at: Vector3, n: Vector3, count: number, rgb: [number, number, number], speed: number): void {
    for (let i = 0; i < count; i++) {
      const k = this.sparkNext++ % MAX_SPARKS
      const r1 = Math.sin(k * 12.9898 + this.sparkNext) * 43758.5453
      const r2 = Math.sin(k * 78.233 + this.sparkNext * 1.7) * 24634.6345
      const r3 = Math.sin(k * 37.719 + this.sparkNext * 0.3) * 17825.1337
      const f = (r: number): number => (r - Math.floor(r)) * 2 - 1
      this.sparkPos[k * 3] = at.x
      this.sparkPos[k * 3 + 1] = at.y
      this.sparkPos[k * 3 + 2] = at.z
      this.sparkVel[k * 3] = (n.x + f(r1) * 0.7) * speed
      this.sparkVel[k * 3 + 1] = (n.y + f(r2) * 0.7 + 0.2) * speed
      this.sparkVel[k * 3 + 2] = (n.z + f(r3) * 0.7) * speed
      this.sparkLife[k] = 0.25 + (f(r1) * 0.5 + 0.5) * 0.25
      this.sparkColor[k * 3] = rgb[0]
      this.sparkColor[k * 3 + 1] = rgb[1]
      this.sparkColor[k * 3 + 2] = rgb[2]
    }
  }

  clearDecals(): void {
    for (const d of this.decals) d.mesh.visible = false
  }

  update(dt: number): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue
      t.life -= dt
      const m = t.line.material as LineBasicMaterial
      m.opacity = Math.max(0, t.life / t.total)
      if (t.life <= 0) t.line.visible = false
    }
    for (const d of this.decals) {
      if (!d.mesh.visible) continue
      d.age += dt
      if (d.age > DECAL_LIFE) d.mesh.visible = false
    }
    for (let k = 0; k < MAX_SPARKS; k++) {
      if (this.sparkLife[k]! <= 0) {
        this.sparkPos[k * 3 + 1] = -100
        continue
      }
      this.sparkLife[k]! -= dt
      this.sparkVel[k * 3 + 1]! -= 5 * dt
      this.sparkPos[k * 3]! += this.sparkVel[k * 3]! * dt
      this.sparkPos[k * 3 + 1]! += this.sparkVel[k * 3 + 1]! * dt
      this.sparkPos[k * 3 + 2]! += this.sparkVel[k * 3 + 2]! * dt
    }
    const a = this.sparks.geometry.getAttribute('position')
    a.needsUpdate = true
    const c = this.sparks.geometry.getAttribute('color')
    c.needsUpdate = true
  }

  get activeDecals(): number {
    return this.decals.filter((d) => d.mesh.visible).length
  }

  dispose(): void {
    for (const t of this.tracers) {
      t.line.geometry.dispose()
      ;(t.line.material as LineBasicMaterial).dispose()
    }
    this.decalGeo.dispose()
    this.decalMat.map?.dispose()
    this.decalMat.dispose()
    this.sparks.geometry.dispose()
    ;(this.sparks.material as PointsMaterial).dispose()
    this.glow.dispose()
  }
}

