import { PRODUCT, type Level } from './product'
import type { Rng } from './types'

// Human-like limits for the real-time games. The same limiter sits in front of a trained agent
// at play time and inside the training env, so every level is trained with its own limits.

export interface LimiterConfig {
  /** Frames the agent's view lags behind the game. */
  delayFrames: number
  /**
   * Presses per minute, or null for no cap. A press is a NEW input: a direction that differs from the held
   * one (and is not neutral), or a button that is newly down. Releases are free (R15), and so is keeping
   * the held input.
   */
  apmCap: number | null
  /** After the held input changes, it stays for at least this many frames. */
  minHoldFrames: number
  /** Arena only (T10): maximum aim turn rate in degrees per second, null for no limit. */
  aimRateDegPerSec?: number | null
  /** Arena only (T10): aim noise in degrees. */
  aimNoiseDeg?: number
  /** The second channel of act() is a bitmask of buttons (arena) rather than one button id (fighter). */
  buttonBits?: boolean
}

/** What a seat knows about its own hands: the policy sees this undelayed, like a human feels their own fingers. */
export interface InputStatus {
  /** The input actually held, after the limiter, as passed to act(). */
  held: [number, number]
  /** Fraction of the APM window still free, 1 when there is no cap. */
  slotsLeft: number
  /** Frames since the last accepted change, capped at STATUS_SINCE_CAP and scaled to 0..1. */
  sinceChange: number
  /** 1 when the last act() or trigger() call was refused (cap or hold), else 0. */
  refused: number
}

/** Longest "frames since the last accepted change" the status distinguishes (two seconds). */
export const STATUS_SINCE_CAP = 120

/**
 * A short history of full game states for scripted bots that must see the same delayed view an agent
 * gets from HumanLimiter (R15): record(frame, state) on the same frames the limiter records, view(frame)
 * returns the newest state at or before frame minus delay, or the oldest while the delay has not elapsed.
 */
export class DelayedStates<T> {
  private readonly slots: number
  private readonly stamps: Int32Array
  private readonly items: Array<T | undefined>
  private size = 0
  private head = 0

  constructor(private readonly delay: number, private readonly make: () => T, private readonly copy: (to: T, from: T) => void) {
    this.slots = Math.max(0, Math.floor(delay)) + 2
    this.stamps = new Int32Array(this.slots)
    this.items = new Array<T | undefined>(this.slots).fill(undefined)
  }

  clear(): void {
    this.size = 0
    this.head = 0
  }

  record(frame: number, state: T): void {
    let slot = this.items[this.head]
    if (slot === undefined) {
      slot = this.make()
      this.items[this.head] = slot
    }
    this.copy(slot, state)
    this.stamps[this.head] = frame
    this.head = (this.head + 1) % this.slots
    if (this.size < this.slots) this.size++
  }

  /** The stored state a seat may see at `frame`, with its frame stamp. */
  view(frame: number): { state: T; frame: number } {
    if (this.size === 0) throw new Error('DelayedStates: nothing recorded yet')
    const want = frame - Math.max(0, Math.floor(this.delay))
    let pick = -1
    let oldest = -1
    for (let k = 0; k < this.size; k++) {
      const i = (this.head - 1 - k + this.slots * 2) % this.slots
      oldest = i
      if (this.stamps[i]! <= want) {
        pick = i
        break
      }
    }
    const i = pick >= 0 ? pick : oldest
    return { state: this.items[i]!, frame: this.stamps[i]! }
  }
}

const MINUTE_FRAMES = 3600
const UNITS_PER_DEG = 8192 / 360
const FRAMES_PER_SEC = 60

export class HumanLimiter {
  private readonly delay: number
  private readonly cap: number
  private readonly slots: number
  private stamps: Int32Array
  private bufs: Float32Array[] = []
  private size = 0
  private head = 0
  private calls = 0
  private held: number[] = [0, 0]
  private lastChange = -1_000_000
  private pressFrames: number[] = []
  private pressHead = 0
  private refused = false

  constructor(private readonly cfg: LimiterConfig, readonly rng: Rng) {
    this.delay = Math.max(0, Math.floor(cfg.delayFrames))
    this.cap = cfg.apmCap === null ? -1 : cfg.apmCap
    this.slots = this.delay + 2
    this.stamps = new Int32Array(this.slots)
  }

  /** Drops the recorded observations only (a new round); the input state and APM window stay. */
  clearViews(): void {
    this.size = 0
    this.head = 0
  }

  /** Forget everything: a new episode. */
  reset(): void {
    this.size = 0
    this.head = 0
    this.calls = 0
    this.held = [0, 0]
    this.lastChange = -1_000_000
    this.pressFrames = []
    this.pressHead = 0
    this.refused = false
  }

  /**
   * Records the observation taken at `frame` (default: one more than the last call, counting from 0)
   * and returns a copy of what the agent may see at that frame: the newest recorded observation at
   * or before frame minus delayFrames, or the oldest one while the delay has not elapsed yet.
   */
  observe(o: Float32Array, frame?: number): Float32Array {
    const f = frame ?? this.calls
    this.calls = f + 1
    this.record(o, f)
    const out = new Float32Array(o.length)
    this.viewInto(f, out, 0)
    return out
  }

  /** Stores an observation without reading one back. */
  record(o: Float32Array, frame: number): void {
    let buf = this.bufs[this.head]
    if (buf === undefined || buf.length !== o.length) {
      buf = new Float32Array(o.length)
      this.bufs[this.head] = buf
    }
    buf.set(o)
    this.stamps[this.head] = frame
    this.head = (this.head + 1) % this.slots
    if (this.size < this.slots) this.size++
  }

  /** Writes the delayed view for `frame` into out[offset..] and returns the frame it was recorded at. Allocation-free. */
  viewInto(frame: number, out: Float32Array, offset: number): number {
    if (this.size === 0) throw new Error('HumanLimiter: nothing observed yet')
    const want = frame - this.delay
    let pick = -1
    let oldest = -1
    for (let k = 0; k < this.size; k++) {
      const i = (this.head - 1 - k + this.slots * 2) % this.slots
      oldest = i
      if (this.stamps[i]! <= want) {
        pick = i
        break
      }
    }
    const at = pick >= 0 ? pick : oldest
    out.set(this.bufs[at]!, offset)
    return this.stamps[at]!
  }

  /** The input currently held (a copy). Proposing exactly this is the free "keep" action. */
  heldInput(): [number, number] {
    return [this.held[0]!, this.held[1]!]
  }

  /** Is the proposal a new press (see LimiterConfig.apmCap)? */
  private isPress(p: number[]): boolean {
    const h = this.held
    if (p[0] !== 0 && p[0] !== h[0]) return true
    return this.cfg.buttonBits ? (p[1]! & ~h[1]!) !== 0 : p[1] !== 0 && p[1] !== h[1]
  }

  /**
   * Filters the proposed input [dir, btn] at `frame`: the input actually held. A change is refused
   * while the previous change is younger than minHoldFrames, and a press (a new direction or a newly
   * down button; releases and keeping the held input are free) is refused while apmCap presses
   * already happened in the last 3600 frames.
   */
  act(proposed: number[], frame: number): number[] {
    const held = this.held
    this.refused = false
    if (proposed[0] === held[0] && proposed[1] === held[1]) return [held[0]!, held[1]!]
    if (frame - this.lastChange < this.cfg.minHoldFrames) {
      this.refused = true
      return [held[0]!, held[1]!]
    }
    if (this.isPress(proposed) && !this.takeSlot(frame)) {
      this.refused = true
      return [held[0]!, held[1]!]
    }
    this.held = [proposed[0]!, proposed[1]!]
    this.lastChange = frame
    return [proposed[0]!, proposed[1]!]
  }

  /** Own-input status at `frame` for the policy's observation (undelayed). */
  status(frame: number): InputStatus {
    let slotsLeft = 1
    if (this.cap >= 0) {
      this.prune(frame)
      slotsLeft = this.cap === 0 ? 0 : Math.max(0, (this.cap - (this.pressFrames.length - this.pressHead)) / this.cap)
    }
    return {
      held: [this.held[0]!, this.held[1]!],
      slotsLeft,
      sinceChange: Math.min(Math.max(frame - this.lastChange, 0), STATUS_SINCE_CAP) / STATUS_SINCE_CAP,
      refused: this.refused ? 1 : 0,
    }
  }

  /**
   * Charges one trigger press at `frame` to the APM window, for a semi-automatic weapon whose trigger is
   * released and pressed again by the env on every decision even while the held input does not change.
   * Returns false (the shot is refused) when the window is full. A press already counted at this very
   * frame by act() is not charged twice.
   */
  trigger(frame: number): boolean {
    if (this.cap < 0) return true
    if (this.pressFrames.length > this.pressHead && this.pressFrames[this.pressFrames.length - 1] === frame) return true
    if (this.takeSlot(frame)) return true
    this.refused = true
    return false
  }

  /** Drops presses older than a minute from the window. */
  private prune(frame: number): void {
    while (this.pressHead < this.pressFrames.length && frame - this.pressFrames[this.pressHead]! >= MINUTE_FRAMES) this.pressHead++
    if (this.pressHead > 1024) {
      this.pressFrames = this.pressFrames.slice(this.pressHead)
      this.pressHead = 0
    }
  }

  /** Takes one APM slot at `frame`; false when apmCap presses already happened in the last 3600 frames. */
  private takeSlot(frame: number): boolean {
    if (this.cap < 0) return true
    this.prune(frame)
    if (this.pressFrames.length - this.pressHead >= this.cap) return false
    this.pressFrames.push(frame)
    return true
  }

  /**
   * Arena aim limits (T10): the per-frame turn the seat may apply, in angle units (8192 per turn).
   * Each axis is clamped to aimRateDegPerSec / 60 degrees per frame (no clamp when the rate is null).
   * Noise: a turning command is jittered by up to aimNoiseDeg degrees over the `frames` frames it is
   * held, scaled by how close the command is to the cap (a flick is less accurate than a nudge); a
   * zero command never jitters, so holding the crosshair still stays exact.
   */
  aim(yaw: number, pitch: number, frames = 1): [number, number] {
    const rate = this.cfg.aimRateDegPerSec
    const cap = rate === null || rate === undefined ? Infinity : Math.floor((rate / FRAMES_PER_SEC) * UNITS_PER_DEG)
    const noise = this.cfg.aimNoiseDeg ?? 0
    const one = (v: number): number => {
      if (v === 0) return 0
      const c = Math.max(-cap, Math.min(cap, v))
      if (noise <= 0) return c
      const frac = cap === Infinity ? 1 : Math.abs(c) / cap
      const jitter = ((this.rng.float() * 2 - 1) * noise * UNITS_PER_DEG * frac) / Math.max(1, frames)
      return c + Math.floor(jitter + 0.5)
    }
    return [one(yaw), one(pitch)]
  }
}

const mk = (delayFrames: number, apmCap: number | null, minHoldFrames: number, aimRate: number | null, aimNoise: number, buttonBits = false): LimiterConfig => ({
  delayFrames, apmCap, minHoldFrames, aimRateDegPerSec: aimRate, aimNoiseDeg: aimNoise, buttonBits,
})

/** No limits at all: the training env uses it for seats without a level so every seat has the same own-input bookkeeping. */
export const UNLIMITED: LimiterConfig = { delayFrames: 0, apmCap: null, minHoldFrames: 0 }

/**
 * Easy 300 ms (18 frames) 100 APM, Medium 250 ms (15) 160, Hard 200 ms (12) 240, Champion the
 * product's minimum delay and no cap. Aim limits are the arena's (T10 applies them). minHoldFrames is
 * a builder choice (not in the plan): about 130, 100, 65 and 17 ms.
 */
function levels(bits: boolean): Record<Level, LimiterConfig> {
  return {
    easy: mk(18, 100, 8, 180, 6, bits),
    medium: mk(15, 160, 6, 300, 3, bits),
    hard: mk(12, 240, 4, 540, 1.5, bits),
    champion: mk(PRODUCT.championMinDelayFrames, null, 1, null, 0, bits),
  }
}

export const LEVEL_LIMITS: Record<'fighter' | 'arena', Record<Level, LimiterConfig>> = {
  fighter: levels(false),
  arena: { ...levels(true), easy: mk(21, 100, 8, 165, 6, true), medium: mk(18, 160, 6, 220, 4, true) },
}
