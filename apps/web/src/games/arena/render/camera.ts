import { PerspectiveCamera } from 'three'
import type { Player } from '@duelwise/core/src/games/arena/state.ts'

// The first person camera of the human seat. Pure maths first (poseFor, lerpAngleUnits), then a small
// rig that adds the things a camera needs over time: eased crouch, a landing dip, a walking bob and a
// death fall. It reads sim state only. Sim coordinates are x, y on the floor and z up in inches; the
// scene uses metres with y up, so a sim point (x, y, z) is (x, z, -y) times UNIT (a right handed map).

/** Metres per sim unit (one unit is an inch). */
export const UNIT = 0.0254
/** 8192 angle units make a full turn. */
export const UNITS_PER_TURN = 8192
export const TAU = Math.PI * 2
/** Vertical field of view in degrees: 106.26 degrees horizontal at 16:9, the sim's own sight cone. */
export const VFOV = 73.74
export const NEAR = 0.03
export const FAR = 120
/** How far the eye sits below the top of a dead player's hull. */
const DEAD_EYE = 14

export const unitsToRad = (u: number): number => (u * TAU) / UNITS_PER_TURN

/** Linear blend between two angles in angle units along the short way round (8192 wraps). */
export function lerpAngleUnits(a: number, b: number, t: number): number {
  let d = (b - a) % UNITS_PER_TURN
  if (d > UNITS_PER_TURN / 2) d -= UNITS_PER_TURN
  else if (d < -UNITS_PER_TURN / 2) d += UNITS_PER_TURN
  return a + d * t
}

/** Mouse turn (angle units, sim signs) moved since the last sim step. */
export interface PendingTurn {
  yaw: number
  pitch: number
}

/** The sim's pitch limit (core.ts), so the view never looks further than the sim does. */
const PITCH_LIMIT = 1900

export interface ViewPose {
  /** Scene metres. */
  x: number
  y: number
  z: number
  /** Radians, three.js rotation.y with the camera looking down -z at 0. */
  yaw: number
  /** Radians, positive looks up. */
  pitch: number
}

/** Sim yaw (angle units, 0 looks along +x) to the camera's rotation.y. */
export const cameraYaw = (yawUnits: number): number => unitsToRad(yawUnits) - Math.PI / 2
/** Sim yaw to the rotation.y of a model whose front faces +z. */
export const modelYaw = (yawUnits: number): number => unitsToRad(yawUnits) + Math.PI / 2

/** Scene position of a sim point. */
export function toScene(x: number, y: number, z: number): [number, number, number] {
  return [x * UNIT, z * UNIT, -y * UNIT]
}

/** Eye height above the feet in sim units, eased between standing and crouching by `crouchAmount` (0..1). */
export function easedEye(crouchAmount: number): number {
  return 64 - 18 * crouchAmount
}

/**
 * The view between two sim states. The view angle includes the weapon punch (recoil), like the
 * reference games show it; `eyeUnits` is the already smoothed eye height.
 */
export function poseFor(prev: Player, next: Player, alpha: number, eyeUnits: number, pending?: PendingTurn): ViewPose {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha
  const lerp = (p: number, n: number): number => p + (n - p) * a
  const x = lerp(prev.x, next.x)
  const y = lerp(prev.y, next.y)
  const z = lerp(prev.z, next.z)
  let yaw: number
  let pitch: number
  if (pending) {
    // The player's own aim is the newest thing there is: the sim's angle plus the mouse movement the sim has not taken yet (R30),
    // so the view follows the mouse every rendered frame instead of the 60 Hz step. Only the recoil punch is blended.
    yaw = next.yaw + lerp(prev.punchYaw, next.punchYaw) + pending.yaw
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, next.pitch + pending.pitch)) + lerp(prev.punchPitch, next.punchPitch)
  } else {
    yaw = lerpAngleUnits(prev.yaw + prev.punchYaw, next.yaw + next.punchYaw, a)
    pitch = lerp(prev.pitch + prev.punchPitch, next.pitch + next.punchPitch)
  }
  return { x: x * UNIT, y: (z + eyeUnits) * UNIT, z: -y * UNIT, yaw: cameraYaw(yaw), pitch: unitsToRad(pitch) }
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(VFOV, 16 / 9, NEAR, FAR)
  private crouch = 0
  private bobPhase = 0
  private landDip = 0
  private wasOnGround = true
  private fall = 0
  private reduced = false
  /** Last view position and angles (scene metres and radians), for audio and the viewmodel. */
  pose: ViewPose = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 }
  /** Horizontal speed in sim units per second at the last update. */
  speed = 0
  /** Roll in radians (the death fall leans the head). */
  roll = 0

  constructor() {
    this.camera.rotation.order = 'YXZ'
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  setReducedMotion(v: boolean): void {
    this.reduced = v
  }

  /** Jump the smoothing to the state (a new round, a seek). */
  snap(p: Player): void {
    this.crouch = p.crouch
    this.landDip = 0
    this.fall = p.alive === 1 ? 0 : 1
    this.wasOnGround = p.onGround === 1
  }

  update(dt: number, prev: Player, next: Player, alpha: number, pending?: PendingTurn): void {
    const k = Math.min(1, dt * 14)
    this.crouch += (next.crouch - this.crouch) * k
    const speed = Math.sqrt(next.vx * next.vx + next.vy * next.vy)
    this.speed = speed
    const grounded = next.onGround === 1
    if (grounded && !this.wasOnGround && !this.reduced) this.landDip = 1
    this.wasOnGround = grounded
    this.landDip = Math.max(0, this.landDip - dt * 5)
    const moving = grounded && next.alive === 1 && speed > 40 && next.crouch === 0
    if (moving) this.bobPhase += dt * (speed / 250) * 11
    this.fall += ((next.alive === 1 ? 0 : 1) - this.fall) * Math.min(1, dt * 5)

    let eye = easedEye(this.crouch)
    eye -= this.landDip * 3
    eye = eye * (1 - this.fall) + DEAD_EYE * this.fall
    const p = poseFor(prev, next, alpha, eye, pending)
    if (moving && !this.reduced) {
      const amp = Math.min(1, speed / 250)
      p.y += Math.abs(Math.sin(this.bobPhase)) * 0.012 * amp
    }
    this.roll = this.reduced ? 0 : this.fall * 0.5
    this.pose = p
    this.camera.position.set(p.x, p.y, p.z)
    this.camera.rotation.set(p.pitch, p.yaw, this.roll)
  }
}
