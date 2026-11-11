import { AdditiveBlending, CanvasTexture, CircleGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry } from 'three'

// Hit language, all drawn in code (no sprites): light 6 rays, medium rays plus a ring, heavy a larger
// ring with a camera shake, block a flat shield arc on the blocker, deflect a green ring that
// expands over 10 frames, counter hit blue and punish counter red. Effects live in a small pool.

export type HitKind = 'light' | 'medium' | 'heavy' | 'block' | 'deflect' | 'counter' | 'punish' | 'throw' | 'ko'

interface Spec {
  rays: number
  ring: number
  size: number
  frames: number
  color: number
  shake: number
  /** Radius of the filled, additive flash at the centre, as a multiple of `size` (0 for none). Heavy, counter and punish read biggest. */
  core: number
}

// Sizes are in render units (a fighter stands 1.7 units tall). A heavy ring peaks at
// about 0.4 units radius (a fist to head sized spark, as in the design panel); light and medium stay
// smaller, and the KO ring is capped near torso height.
export const HIT_SPECS: Readonly<Record<HitKind, Spec>> = {
  light: { rays: 6, ring: 0, size: 0.14, frames: 8, color: 0xfff0d0, shake: 0, core: 0.85 },
  medium: { rays: 8, ring: 1, size: 0.2, frames: 10, color: 0xffd9a0, shake: 0, core: 1.0 },
  heavy: { rays: 8, ring: 1.3, size: 0.26, frames: 14, color: 0xffb070, shake: 0.05, core: 1.3 },
  block: { rays: 0, ring: 0, size: 0.3, frames: 10, color: 0xcfe4ff, shake: 0, core: 0 },
  deflect: { rays: 0, ring: 1.8, size: 0.2, frames: 10, color: 0x6bf09a, shake: 0, core: 0 },
  counter: { rays: 8, ring: 1.4, size: 0.22, frames: 12, color: 0x6aa8ff, shake: 0.04, core: 1.6 },
  punish: { rays: 10, ring: 1.5, size: 0.26, frames: 14, color: 0xff5a4a, shake: 0.06, core: 1.9 },
  throw: { rays: 6, ring: 1.4, size: 0.22, frames: 12, color: 0xfff0d0, shake: 0.04, core: 1.2 },
  ko: { rays: 12, ring: 1.6, size: 0.3, frames: 22, color: 0xffd9a0, shake: 0.08, core: 1.5 },
}

/** The ring grows to this multiple of size * ring at its peak (see Fx.step). */
const RING_PEAK = 1.2

/** Largest ring radius (render units) a kind ever draws; 0 for kinds without a ring. */
/** Largest radius (render units) of the filled core flash; 0 for kinds without one. */
export function maxCoreRadius(kind: HitKind): number {
  return HIT_SPECS[kind].size * HIT_SPECS[kind].core * CORE_PEAK
}

/** The core grows to this multiple of its radius while it fades. */
const CORE_PEAK = 1

export function maxRingRadius(kind: HitKind): number {
  const s = HIT_SPECS[kind]
  return s.ring > 0 ? s.size * s.ring * RING_PEAK : 0
}

const MAX_RAYS = 12
const POOL = 14

class Fx {
  readonly group = new Group()
  readonly rays: Mesh[] = []
  readonly ring: Mesh
  readonly arc: Mesh
  readonly core: Mesh
  /** A small white-hot flash inside the core: the first frames of a burst read as light, not as a coloured disc. */
  readonly hot: Mesh
  readonly mats: MeshBasicMaterial[] = []
  age = 0
  frames = 1
  active = false
  /** Which presentation event made this spark (rollback play), or -1. A cancelled event cuts its spark short. */
  tag = -1
  spec: Spec = HIT_SPECS.light
  facing = 1

  constructor(rayGeo: PlaneGeometry, ringGeo: RingGeometry, arcGeo: CircleGeometry, coreGeo: CircleGeometry, coreTex: CanvasTexture | null) {
    const mk = (): MeshBasicMaterial => {
      const m = new MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false })
      this.mats.push(m)
      return m
    }
    for (let i = 0; i < MAX_RAYS; i++) {
      const r = new Mesh(rayGeo, mk())
      this.rays.push(r)
      this.group.add(r)
    }
    this.ring = new Mesh(ringGeo, mk())
    this.arc = new Mesh(arcGeo, mk())
    const coreMat = mk()
    if (coreTex) coreMat.map = coreTex // a soft falloff, so the flash reads as light rather than a flat disc
    this.core = new Mesh(coreGeo, coreMat)
    const hotMat = mk()
    if (coreTex) hotMat.map = coreTex
    this.hot = new Mesh(coreGeo, hotMat)
    this.group.add(this.core, this.hot, this.ring, this.arc)
    this.group.visible = false
  }

  start(kind: HitKind, spec: Spec, x: number, y: number, facing: number, tag = -1): void {
    this.tag = tag
    this.spec = spec
    this.facing = facing
    this.frames = spec.frames
    this.age = 0
    this.active = true
    this.group.visible = true
    this.group.position.set(x, y, 0.7)
    const col = new Color(spec.color)
    for (const m of this.mats) m.color.copy(col)
    ;(this.hot.material as MeshBasicMaterial).color.set(0xffffff)
    for (let i = 0; i < MAX_RAYS; i++) {
      const r = this.rays[i]!
      r.visible = i < spec.rays
      if (i < spec.rays) r.rotation.z = (i / spec.rays) * Math.PI * 2 + (i % 2) * 0.12
    }
    this.ring.visible = spec.ring > 0
    this.arc.visible = kind === 'block'
    this.core.visible = spec.core > 0
    this.hot.visible = spec.core > 0
    // Block: a half disc facing the attacker, drawn as a flat shield.
    if (kind === 'block') {
      this.arc.rotation.z = facing > 0 ? 0 : Math.PI
    }
  }

  step(frames: number): void {
    this.age += frames
    const u = this.age / this.frames
    if (u >= 1) {
      this.active = false
      this.group.visible = false
      return
    }
    const s = this.spec
    const fade = 1 - u * u
    const grow = 1 - (1 - u) * (1 - u)
    for (let i = 0; i < s.rays; i++) {
      const r = this.rays[i]!
      // A ray is a thin bar offset from the centre along its angle and stretched as it flies out.
      const ang = r.rotation.z
      const dist = s.size * (0.25 + 0.85 * grow)
      r.position.set(Math.cos(ang) * dist, Math.sin(ang) * dist, 0)
      r.scale.set(s.size * (0.7 - 0.4 * u), s.size * 0.16 * (1 - u), 1)
      ;(r.material as MeshBasicMaterial).opacity = fade
    }
    if (s.core > 0) {
      // A filled flash: it punches out fast (first third of the life) and burns out, brightest at the start.
      const punch = Math.min(1, u * 3)
      const cs = s.size * s.core * (0.45 + 0.55 * (1 - (1 - punch) * (1 - punch)))
      this.core.scale.set(cs, cs, 1)
      ;(this.core.material as MeshBasicMaterial).opacity = 0.95 * (1 - u) * (1 - u)
      // White-hot centre: about half the core, gone by the middle of the life.
      const hs = cs * 0.55
      this.hot.scale.set(hs, hs, 1)
      ;(this.hot.material as MeshBasicMaterial).opacity = Math.max(0, 1 - u * 2.2)
    }
    if (s.ring > 0) {
      const rs = s.size * s.ring * (RING_PEAK - 0.9 * (1 - grow))
      this.ring.scale.set(rs, rs, 1)
      ;(this.ring.material as MeshBasicMaterial).opacity = (this.spec.core > 0 ? 0.3 : 0.9) * fade // a hit's ring is the faint shock edge of the flash; a deflect keeps its bold ring
    }
    if (this.arc.visible) {
      const as = s.size * (0.6 + 0.4 * grow)
      this.arc.scale.set(as * 0.55, as, 1)
      this.arc.position.x = this.facing * 0.05
      ;(this.arc.material as MeshBasicMaterial).opacity = 0.55 * fade
    }
  }
}

/** White centre fading to nothing at the edge; null where there is no DOM (unit tests). */
function softDisc(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.7)')
  grad.addColorStop(0.75, 'rgba(255,255,255,0.18)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new CanvasTexture(c)
}

export class Vfx {
  private readonly coreTex: CanvasTexture | null
  readonly group = new Group()
  private readonly pool: Fx[] = []
  private next = 0
  /** Camera shake (world units, frames) requested by the last spawn, consumed by the renderer. */
  pendingShake: { amount: number; frames: number } | null = null

  constructor() {
    const rayGeo = new PlaneGeometry(1, 1)
    const ringGeo = new RingGeometry(0.9, 1, 40)
    const arcGeo = new CircleGeometry(1, 24, -Math.PI / 2, Math.PI)
    const coreGeo = new CircleGeometry(1, 28)
    this.coreTex = softDisc()
    for (let i = 0; i < POOL; i++) {
      const fx = new Fx(rayGeo, ringGeo, arcGeo, coreGeo, this.coreTex)
      this.pool.push(fx)
      this.group.add(fx.group)
    }
  }

  /** World position in render units (sim / 100). */
  spawn(kind: HitKind, x: number, y: number, facing: number, tag = -1): void {
    const spec = HIT_SPECS[kind]
    let fx = this.pool.find((f) => !f.active)
    if (!fx) {
      fx = this.pool[this.next]!
      this.next = (this.next + 1) % POOL
    }
    fx.start(kind, spec, x, y, facing, tag)
    this.spawned++
    if (spec.shake > 0) this.pendingShake = { amount: spec.shake, frames: 6 }
  }

  /** A re-run took back the event that made spark `tag`: let it fade out over its next 2 frames instead of playing on. */
  cancel(tag: number): void {
    for (const fx of this.pool) {
      if (fx.active && fx.tag === tag) fx.frames = Math.min(fx.frames, fx.age + 2)
    }
  }

  /** Advance by `dt` seconds (effects run in real time, also during hitstop). */
  update(dt: number): void {
    const frames = dt * 60
    for (const fx of this.pool) if (fx.active) fx.step(frames)
  }

  /** Shows one of every kind at once so the renderer can compile their programs before the first real hit, then hides them all again. */
  withEveryKind(compile: () => void): void {
    const before = this.spawned
    const kinds = Object.keys(HIT_SPECS) as HitKind[]
    kinds.forEach((k, i) => {
      const fx = this.pool[i % POOL]!
      fx.start(k, HIT_SPECS[k], 0, 1, 1)
    })
    try {
      compile()
    } finally {
      for (const fx of this.pool) {
        fx.active = false
        fx.group.visible = false
      }
      this.spawned = before
    }
  }

  /** Number of effects spawned since creation (tests and diagnostics). */
  spawned = 0

  activeCount(): number {
    return this.pool.filter((f) => f.active).length
  }

  dispose(): void {
    this.coreTex?.dispose()
    const seen = new Set<unknown>()
    for (const fx of this.pool) {
      for (const m of fx.mats) m.dispose()
      for (const o of [...fx.rays, fx.core, fx.hot, fx.ring, fx.arc]) {
        if (!seen.has(o.geometry)) {
          seen.add(o.geometry)
          o.geometry.dispose()
        }
      }
    }
  }
}
