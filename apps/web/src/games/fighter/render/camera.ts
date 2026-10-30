import { PerspectiveCamera, Vector3 } from 'three'

// Perspective camera on a 2D plane: tracks the fighters' midpoint with a 120 ms critically damped
// follow, zooms with their distance and clamps to the stage. All sim units are world units / UNIT.

export const UNIT = 100
export const STAGE_LIMIT = 800
export const FOLLOW_SECONDS = 0.12
/** Half the view width in sim units at zoom 1 (16:9, see apply()). */
export const VIEW_HALF = 430
/** How far past a wall the frame may reach, so a fighter standing on the wall is not cut in half. */
export const WALL_MARGIN = 60
/** The fighters are never further apart than this (core MAX_SEPARATION, fighter-env-3); the zoom is sized for it. */
const FAR = 850

/** 0.86x at the greatest legal separation (850), 1.0x at 500 apart, 1.15x under 220 (linear between). */
export function zoomForDistance(dist: number): number {
  const d = Math.abs(dist)
  if (d <= 220) return 1.15
  if (d <= 500) return 1.15 - (0.15 * (d - 220)) / 280
  if (d >= FAR) return 0.86
  return 1 - (0.14 * (d - 500)) / (FAR - 500)
}

/** Critically damped spring step (Unity SmoothDamp form). Returns [value, velocity]. */
export function smoothDamp(cur: number, target: number, vel: number, smoothTime: number, dt: number): [number, number] {
  const omega = 2 / Math.max(0.0001, smoothTime)
  const x = omega * dt
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = cur - target
  const temp = (vel + omega * change) * dt
  const nv = (vel - omega * temp) * e
  return [target + (change + temp) * e, nv]
}

/** Camera x limit so the view never shows past the stage walls at a given zoom and aspect. */
export function clampCameraX(x: number, zoom: number): number {
  const lim = STAGE_LIMIT + WALL_MARGIN - VIEW_HALF / zoom
  return Math.max(-lim, Math.min(lim, x))
}

export class CameraRig {
  readonly camera: PerspectiveCamera
  private x = 0
  private vx = 0
  private zoom = 1
  private vz = 0
  private y = 1.05
  private shake = 0
  private shakeFrames = 0
  private reduced = false
  private hold = 0
  private holdX = 0
  private readonly look = new Vector3()
  /** Vertical field of view in degrees: narrow, so the view reads close to orthographic. */
  static readonly FOV = 26

  constructor() {
    this.camera = new PerspectiveCamera(CameraRig.FOV, 16 / 9, 0.1, 120)
    this.apply(0)
  }

  setReducedMotion(v: boolean): void {
    this.reduced = v
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  /** A shake of `amount` world units for `frames` render frames (6 for a heavy hit). Ignored under reduced motion. */
  kick(amount: number, frames: number): void {
    if (this.reduced) return
    this.shake = Math.max(this.shake, amount)
    this.shakeFrames = Math.max(this.shakeFrames, frames)
  }

  /** Hold the camera on `focusX` (sim units) for `frames` sim frames at 60 Hz (the super hold on the attacker). */
  freeze(frames: number, focusX: number): void {
    this.hold = frames
    this.holdX = focusX
  }

  get holding(): boolean {
    return this.hold > 0
  }

  /** Snap with no smoothing (first frame, round reset). */
  snap(midX: number, dist: number): void {
    this.zoom = zoomForDistance(dist)
    this.x = clampCameraX(midX, this.zoom)
    this.vx = 0
    this.vz = 0
    this.apply(0)
  }

  update(dt: number, midX: number, dist: number, push = 0): void {
    const dts = Math.min(dt, 0.05)
    // Reduced motion: no push in.
    const zt = zoomForDistance(dist) + (this.reduced ? 0 : push)
    const focus = this.hold > 0 ? this.holdX : midX
    if (this.hold > 0) this.hold = Math.max(0, this.hold - dts * 60)
    const [x, vx] = smoothDamp(this.x, clampCameraX(focus, zt), this.vx, FOLLOW_SECONDS, dts)
    this.x = x
    this.vx = vx
    const [z, vz] = smoothDamp(this.zoom, zt, this.vz, FOLLOW_SECONDS, dts)
    this.zoom = z
    this.vz = vz
    this.apply(dt)
  }

  private apply(_dt: number): void {
    // View width at zoom 1 is about 8.7 units at 16:9: the fighters fill about a third of the height.
    const halfH = 2.45 / this.zoom
    const dist = halfH / Math.tan((CameraRig.FOV * Math.PI) / 360)
    let sx = 0
    let sy = 0
    if (this.shakeFrames > 0) {
      const k = this.shakeFrames / 6
      sx = (this.shakeFrames % 2 === 0 ? 1 : -1) * this.shake * k
      sy = (this.shakeFrames % 3 === 0 ? 1 : -1) * this.shake * 0.6 * k
      this.shakeFrames--
      if (this.shakeFrames === 0) this.shake = 0
    }
    const cx = this.x / UNIT
    this.camera.position.set(cx + sx, this.y + 0.15 + sy, dist)
    this.look.set(cx + sx, this.y + sy, 0)
    this.camera.lookAt(this.look)
  }

  get currentZoom(): number {
    return this.zoom
  }
  get currentX(): number {
    return this.x
  }
}
