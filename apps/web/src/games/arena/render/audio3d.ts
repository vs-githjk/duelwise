import { getVolume, isMuted, subscribeAudio } from '../../../lib/audio'
import type { Player } from '@duelwise/core/src/games/arena/state.ts'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons.ts'

// Positional sound for the shooter: shots, footsteps, reloads and hit ticks, all synthesised with the
// Web Audio API (filtered noise bursts and short tones), so there is no sound asset to license or
// download. Opponent sounds are placed in the scene with an HRTF panner; your own sounds are centred.
// The pure parts (footstep cadence, what is audible) are exported for tests.

/** Sim units walked per footstep while running. */
export const STRIDE = 58
/** Below this fraction of the weapon's top speed a seat is walking quietly (shift walk) and makes no step sound. */
export const QUIET_FRACTION = 0.6

/** Counts footsteps from distance travelled; call advance each frame with the distance moved. */
export class FootstepClock {
  private acc = 0
  constructor(private readonly stride = STRIDE) {}
  advance(distance: number, audible: boolean): number {
    if (!audible) {
      this.acc = 0
      return 0
    }
    this.acc += distance
    let n = 0
    while (this.acc >= this.stride) {
      this.acc -= this.stride
      n++
    }
    return n
  }
  reset(): void {
    this.acc = 0
  }
}

/** Whether a seat's movement is loud enough for steps: grounded, upright, running (not shift walking). */
export function stepsAudible(p: Player): boolean {
  if (p.alive === 0 || p.onGround === 0 || p.crouch === 1) return false
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
  return speed > WEAPONS[p.weapon]!.maxSpeed * QUIET_FRACTION
}

export type SoundKind = 'shot' | 'step' | 'reload' | 'hit' | 'headshot' | 'tick' | 'impact' | 'land'

export interface Audio3DOptions {
  volume?: number
  muted?: boolean
}

export class Audio3D {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private volume: number
  private muted: boolean
  private unsub: (() => void) | null = null

  /** Starts from the site-wide volume and mute (lib/audio) and follows later changes, unless the options pin them. */
  constructor(opts: Audio3DOptions = {}) {
    this.volume = opts.volume ?? getVolume()
    this.muted = opts.muted ?? isMuted()
    if (opts.volume === undefined && opts.muted === undefined) {
      this.unsub = subscribeAudio(() => {
        this.setVolume(getVolume())
        this.setMuted(isMuted())
      })
    }
  }

  /** Create or resume the audio context. Call from a user gesture (a click on the play page). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) return
        this.ctx = new Ctor()
        this.master = this.ctx.createGain()
        this.master.gain.value = this.muted ? 0 : this.volume
        const comp = this.ctx.createDynamicsCompressor()
        this.master.connect(comp)
        comp.connect(this.ctx.destination)
        const len = Math.floor(this.ctx.sampleRate * 0.6)
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
        const d = this.noise.getChannelData(0)
        let seed = 1234567
        for (let i = 0; i < len; i++) {
          seed = (seed * 1664525 + 1013904223) >>> 0
          d[i] = seed / 2147483648 - 1
        }
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume()
    } catch {
      this.ctx = null
    }
  }

  get running(): boolean {
    return this.ctx?.state === 'running'
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    if (this.master && !this.muted) this.master.gain.value = this.volume
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.master) this.master.gain.value = m ? 0 : this.volume
  }

  /** Listener at the camera. yaw is the camera's rotation.y; position in scene metres. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    const c = this.ctx
    if (!c) return
    const l = c.listener
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    if (l.positionX) {
      l.positionX.value = x
      l.positionY.value = y
      l.positionZ.value = z
      l.forwardX.value = fx
      l.forwardY.value = 0
      l.forwardZ.value = fz
      l.upX.value = 0
      l.upY.value = 1
      l.upZ.value = 0
    }
  }

  /** Plays one sound. `at` is a scene position for the opponent's sounds, null for your own (centred). */
  play(kind: SoundKind, weapon: number, at: [number, number, number] | null, gain = 1): void {
    const c = this.ctx
    if (!c || !this.master || c.state !== 'running' || this.muted) return
    const now = c.currentTime
    let out: AudioNode = this.master
    if (at) {
      const pan = c.createPanner()
      pan.panningModel = 'HRTF'
      pan.distanceModel = 'inverse'
      pan.refDistance = 3
      pan.rolloffFactor = 1.3
      pan.maxDistance = 60
      pan.positionX.value = at[0]
      pan.positionY.value = at[1]
      pan.positionZ.value = at[2]
      pan.connect(this.master)
      out = pan
    }
    const g = c.createGain()
    g.connect(out)
    switch (kind) {
      case 'shot': {
        const heavy = weapon === 1
        this.burst(g, now, heavy ? 0.22 : weapon === 2 ? 0.17 : 0.13, heavy ? 1400 : weapon === 2 ? 1900 : 2600, 1.0 * gain, 'bandpass')
        this.tone(g, now, 95, 0.12, 0.9 * gain, 40)
        break
      }
      case 'step':
        this.burst(g, now, 0.06, 420, 0.5 * gain, 'lowpass')
        break
      case 'land':
        this.burst(g, now, 0.1, 300, 0.8 * gain, 'lowpass')
        break
      case 'reload':
        this.burst(g, now, 0.03, 3200, 0.5 * gain, 'highpass')
        this.burst(g, now + 0.55, 0.04, 2600, 0.6 * gain, 'highpass')
        this.burst(g, now + 1.35, 0.03, 3600, 0.7 * gain, 'highpass')
        break
      case 'hit':
        this.tone(g, now, 1500, 0.05, 0.5 * gain, 1200)
        break
      case 'headshot':
        this.tone(g, now, 2100, 0.09, 0.6 * gain, 1700)
        break
      case 'tick':
        this.tone(g, now, 900, 0.03, 0.3 * gain, 700)
        break
      case 'impact':
        this.burst(g, now, 0.05, 3000, 0.35 * gain, 'highpass')
        break
    }
    // Free the panner after the longest sound.
    window.setTimeout(() => {
      try {
        g.disconnect()
        if (out !== this.master) out.disconnect()
      } catch {
        /* already gone */
      }
    }, 2200)
  }

  private burst(dest: AudioNode, t: number, dur: number, freq: number, amp: number, type: BiquadFilterType): void {
    const c = this.ctx!
    const src = c.createBufferSource()
    src.buffer = this.noise
    const f = c.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = 0.7
    const e = c.createGain()
    e.gain.setValueAtTime(0.0001, t)
    e.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), t + 0.004)
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f)
    f.connect(e)
    e.connect(dest)
    src.start(t)
    src.stop(t + dur + 0.05)
  }

  private tone(dest: AudioNode, t: number, from: number, dur: number, amp: number, to: number): void {
    const c = this.ctx!
    const o = c.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(from, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur)
    const e = c.createGain()
    e.gain.setValueAtTime(0.0001, t)
    e.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), t + 0.005)
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(e)
    e.connect(dest)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    try {
      void this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.ctx = null
    this.master = null
  }
}
