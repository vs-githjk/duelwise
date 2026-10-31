import { getVolume, isMuted } from '../../lib/audio'
import { playStinger } from '../../lib/music'

// Small synthesised cues (Web Audio: filtered noise for card and chip clicks, oscillators for the result
// jingles), so there are no sample files to license. They honour the shared master volume and mute.

type Cue = 'deal' | 'flip' | 'chip' | 'check' | 'fold' | 'allin' | 'win' | 'lose' | 'draw' | 'reject'

interface Tone {
  freq: number
  at: number
  len: number
  type?: OscillatorType
  gain?: number
}

/** A short burst of band-passed noise: a card snap (high, short) or a chip click (lower, with a ring). */
interface Click {
  at: number
  len: number
  freq: number
  q: number
  gain: number
}

const TONES: Partial<Record<Cue, Tone[]>> = {
  chip: [{ freq: 1480, at: 0.005, len: 0.06, type: 'triangle', gain: 0.35 }],
  allin: [
    { freq: 330, at: 0, len: 0.1, type: 'triangle', gain: 0.6 },
    { freq: 494, at: 0.08, len: 0.1, type: 'triangle', gain: 0.6 },
    { freq: 659, at: 0.16, len: 0.2, type: 'triangle', gain: 0.6 },
  ],
  check: [{ freq: 220, at: 0, len: 0.05, type: 'sine', gain: 0.6 }],
  reject: [{ freq: 180, at: 0, len: 0.14, type: 'square', gain: 0.4 }],
  win: [
    { freq: 523, at: 0, len: 0.14 },
    { freq: 659, at: 0.14, len: 0.14 },
    { freq: 784, at: 0.28, len: 0.28 },
  ],
  lose: [
    { freq: 392, at: 0, len: 0.16 },
    { freq: 294, at: 0.16, len: 0.3 },
  ],
  draw: [
    { freq: 440, at: 0, len: 0.14 },
    { freq: 440, at: 0.18, len: 0.2 },
  ],
}

const CLICKS: Partial<Record<Cue, Click[]>> = {
  deal: [
    { at: 0, len: 0.05, freq: 2600, q: 1.2, gain: 0.9 },
    { at: 0.11, len: 0.05, freq: 2400, q: 1.2, gain: 0.8 },
  ],
  flip: [{ at: 0, len: 0.06, freq: 3000, q: 1, gain: 0.8 }],
  chip: [{ at: 0, len: 0.035, freq: 1900, q: 3, gain: 0.9 }],
  fold: [{ at: 0, len: 0.12, freq: 900, q: 0.7, gain: 0.7 }],
}

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

function context(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  ctx ??= new AudioContext()
  return ctx
}

function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noise) return noise
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.2), ac.sampleRate)
  const data = buf.getChannelData(0)
  // A fixed pattern, not Math.random: the page's sounds are the same every time.
  let x = 12345
  for (let i = 0; i < data.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) | 0
    data[i] = (x / 0x80000000) * 0.8
  }
  noise = buf
  return buf
}

/** Plays one cue. Silent when muted or when the browser blocks audio; never throws. `delayMs` staggers a reveal. */
export function playCue(name: Cue, delayMs = 0): void {
  // The result sounds are the shared win and loss stingers (lib/music.ts), which also duck the music; the draw jingle stays here.
  if (name === 'win' || name === 'lose') return playStinger(name === 'win' ? 'win' : 'loss', delayMs)
  try {
    if (isMuted()) return
    const ac = context()
    if (!ac) return
    void ac.resume().catch(() => {})
    const master = getVolume()
    const t0 = ac.currentTime + delayMs / 1000
    for (const n of TONES[name] ?? []) {
      const osc = ac.createOscillator()
      const amp = ac.createGain()
      osc.type = n.type ?? 'sine'
      osc.frequency.value = n.freq
      const peak = 0.18 * master * (n.gain ?? 1)
      amp.gain.setValueAtTime(0.0001, t0 + n.at)
      amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + n.at + 0.01)
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len)
      osc.connect(amp).connect(ac.destination)
      osc.start(t0 + n.at)
      osc.stop(t0 + n.at + n.len + 0.02)
    }
    for (const c of CLICKS[name] ?? []) {
      const src = ac.createBufferSource()
      src.buffer = noiseBuffer(ac)
      const band = ac.createBiquadFilter()
      band.type = 'bandpass'
      band.frequency.value = c.freq
      band.Q.value = c.q
      const amp = ac.createGain()
      const peak = 0.5 * master * c.gain
      amp.gain.setValueAtTime(Math.max(peak, 0.0002), t0 + c.at)
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + c.at + c.len)
      src.connect(band).connect(amp).connect(ac.destination)
      src.start(t0 + c.at)
      src.stop(t0 + c.at + c.len + 0.02)
    }
  } catch {
    // never let a sound break a game
  }
}

export type HoldemCue = Cue
