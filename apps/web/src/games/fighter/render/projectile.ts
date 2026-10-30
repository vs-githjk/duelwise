import { AdditiveBlending, CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, SRGBColorSpace } from 'three'

// The Special projectile: an emissive hot core, a soft additive glow that pulses, and a trail of fading
// glows behind it (R30: it used to be a flat disc). All drawn in code; the bloom pass makes it burn.

export const TRAIL_LENGTH = 7
/** Render units between trail glows. */
export const TRAIL_STEP = 0.17
export const CORE_RADIUS = 0.085
export const GLOW_SIZE = 0.55

export interface TrailPoint {
  /** Offset behind the head along the travel direction (render units, always opposite to `facing`). */
  offset: number
  /** 0..1, 1 at the head. */
  strength: number
}

/** Where the trail glows sit and how strong each is: evenly spaced behind the head, fading and shrinking away from it. */
export function trailPoints(): TrailPoint[] {
  return Array.from({ length: TRAIL_LENGTH }, (_, i) => ({ offset: (i + 1) * TRAIL_STEP, strength: 1 - (i + 1) / (TRAIL_LENGTH + 1) }))
}

/** Which way the shot travels: the sign of its own velocity. `fallback` (the owner's facing) only applies to a shot with no velocity. */
export function travelDirection(vx: number, fallback: number): number {
  return vx > 0 ? 1 : vx < 0 ? -1 : fallback
}

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.12, 'rgba(255,214,140,0.7)')
  grad.addColorStop(0.4, 'rgba(255,150,60,0.22)')
  grad.addColorStop(1, 'rgba(255,110,30,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}

export class ProjectileFx {
  readonly group = new Group()
  private readonly core: Mesh
  private readonly glow: Mesh
  private readonly trail: Mesh[] = []
  private readonly points = trailPoints()
  private readonly texture: CanvasTexture
  private readonly owned: Array<{ dispose(): void }> = []

  constructor() {
    this.texture = glowTexture()
    const quad = new PlaneGeometry(1, 1)
    const mat = (opacity: number) => {
      const m = new MeshBasicMaterial({ map: this.texture, color: 0xffffff, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, toneMapped: false })
      this.owned.push(m)
      return m
    }
    const coreGeo = new SphereGeometry(CORE_RADIUS, 16, 12)
    const coreMat = new MeshBasicMaterial({ color: 0xfff6d8, toneMapped: false })
    this.owned.push(quad, coreGeo, coreMat)
    this.core = new Mesh(coreGeo, coreMat)
    this.glow = new Mesh(quad, mat(0.8))
    this.group.add(this.glow, this.core)
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const t = new Mesh(quad, mat(0.3))
      this.trail.push(t)
      this.group.add(t)
    }
    this.group.visible = false
  }

  /** Positions the effect at the projectile (render units) travelling toward `facing` (+1 right, -1 left; callers pass travelDirection of the shot's vx). */
  update(on: boolean, x: number, y: number, facing: number, clock: number): void {
    this.group.visible = on
    if (!on) return
    const pulse = 1 + 0.18 * Math.sin(clock * 30)
    this.core.position.set(x, y, 0.1)
    this.core.scale.setScalar(pulse)
    this.glow.position.set(x, y, 0.09)
    this.glow.scale.setScalar(GLOW_SIZE * pulse)
    this.points.forEach((p, i) => {
      const t = this.trail[i]!
      t.position.set(x - facing * p.offset, y, 0.08)
      t.scale.setScalar(GLOW_SIZE * (0.3 + 0.45 * p.strength))
      ;(t.material as MeshBasicMaterial).opacity = 0.4 * p.strength
    })
  }

  dispose(): void {
    for (const o of this.owned) o.dispose()
    this.texture.dispose()
  }
}
