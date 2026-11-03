import { getVolume, isMuted } from '../../lib/audio'
import { playStinger } from '../../lib/music'

export type SlackCue = 'place' | 'win' | 'lose' | 'draw'

// One short synthesised tap for a placed disc (Web Audio, no files), honouring the shared volume and mute. The full sound set comes later.
let ctx: AudioContext | null = null
function placeTap(): void {
  try {
    if (isMuted() || typeof AudioContext === 'undefined') return
    ctx ??= new AudioContext()
    void ctx.resume().catch(() => {})
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    const amp = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(320, t0)
    osc.frequency.exponentialRampToValueAtTime(190, t0 + 0.07)
    const peak = Math.max(0.16 * getVolume(), 0.0002)
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.01)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09)
    osc.connect(amp).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + 0.11)
  } catch {
    // never let a sound break a game
  }
}

/** Plays one cue through the shared helpers, so mute and volume apply. A win or a loss is the shared result stinger, which also ducks the music. Never throws. */
export function playCue(cue: SlackCue, delayMs = 0): void {
  if (cue === 'win' || cue === 'lose') return playStinger(cue === 'win' ? 'win' : 'loss', delayMs)
  if (cue === 'draw') return
  if (delayMs > 0) setTimeout(placeTap, delayMs)
  else placeTap()
}
