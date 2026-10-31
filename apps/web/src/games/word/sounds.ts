import { getVolume, isMuted } from '../../lib/audio'
import { playStinger } from '../../lib/music'

// Small synthesised cues (Web Audio oscillators, no sample files), so there is nothing to license.
// They honour the shared master volume and mute from lib/audio.

type Cue = 'reject' | 'flip' | 'dot' | 'ring' | 'dash' | 'win' | 'lose' | 'draw'

interface Note {
  freq: number
  at: number
  len: number
  type?: OscillatorType
  gain?: number
}

const CUES: Record<Cue, Note[]> = {
  reject: [{ freq: 180, at: 0, len: 0.14, type: 'square', gain: 0.5 }],
  flip: [{ freq: 520, at: 0, len: 0.04, type: 'triangle', gain: 0.5 }],
  dot: [{ freq: 784, at: 0, len: 0.09, type: 'sine' }],
  ring: [{ freq: 587, at: 0, len: 0.08, type: 'sine', gain: 0.8 }],
  dash: [{ freq: 330, at: 0, len: 0.06, type: 'sine', gain: 0.6 }],
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

let ctx: AudioContext | null = null

function context(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  ctx ??= new AudioContext()
  return ctx
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
    for (const n of CUES[name]) {
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
  } catch {
    // never let a sound break a game
  }
}

export const MARKER_CUE = ['dash', 'ring', 'dot'] as const
