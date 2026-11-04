import { getVolume, isMuted, play, registerSounds, sharedAudioContext } from '../../lib/audio'
import { playStinger } from '../../lib/music'

// Stormglass cues (design spec 2.8). Kenney Interface Sounds and Impact Sounds (CC0), saved under public/assets/ui/kenney
// with their licence files. No water sample is in the repo, so a miss is a splash synthesized below (design spec 2.8).
const BASE = '/assets/ui/kenney'

registerSounds({
  'fleet-aim': `${BASE}/interface-sounds/tick_002.ogg`,
  'fleet-fire': `${BASE}/impact-sounds/impactPlate_light_000.ogg`,
  'fleet-hit': `${BASE}/impact-sounds/impactPlate_medium_000.ogg`,
  'fleet-sunk': `${BASE}/interface-sounds/confirmation_002.ogg`,
})

export type FleetCue = 'aim' | 'fire' | 'miss' | 'hit' | 'sunk' | 'win' | 'lose'

/** Gain per cue; a cue for the opponent's shot passes its own gain on top. */
const GAIN: Record<string, number> = { aim: 0.6, fire: 0.6, miss: 0.5 }

/** Playback rate per cue: the sink is the confirmation sample four semitones down (spec 2.8). */
const RATE: Record<string, number> = { sunk: 0.8 }

/** Length of the splash, in seconds (spec 2.8: a 180 ms filtered noise burst). */
export const SPLASH_SECONDS = 0.18

/** A short low-passed noise burst through the shared AudioContext, so mute and the master volume apply. Silent where Web Audio is missing. */
function splash(gain: number): void {
  if (isMuted()) return
  const ctx = sharedAudioContext()
  if (!ctx) return
  try {
    const n = Math.max(1, Math.floor(ctx.sampleRate * SPLASH_SECONDS))
    const buf = ctx.createBuffer(1, n, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(2400, ctx.currentTime)
    filter.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + SPLASH_SECONDS)
    const amp = ctx.createGain()
    const peak = Math.max(0.0001, gain * getVolume())
    amp.gain.setValueAtTime(peak, ctx.currentTime)
    amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + SPLASH_SECONDS)
    src.connect(filter)
    filter.connect(amp)
    amp.connect(ctx.destination)
    src.start()
  } catch {
    // no Web Audio: the miss is silent
  }
}

/** Plays one cue through the shared helper, so mute and volume apply. Silent when blocked; never throws. */
export function playCue(cue: FleetCue, gain = 1, delayMs = 0): void {
  // The result sounds are the shared win and loss stingers (lib/music.ts), which also duck the music.
  if (cue === 'win' || cue === 'lose') return playStinger(cue === 'win' ? 'win' : 'loss', delayMs)
  const g = (GAIN[cue] ?? 1) * gain
  if (cue === 'miss') {
    if (delayMs > 0) setTimeout(() => splash(g), delayMs)
    else splash(g)
    return
  }
  const rate = RATE[cue]
  const opts = rate === undefined ? { gain: g } : { gain: g, rate }
  if (delayMs > 0) setTimeout(() => play(`fleet-${cue}`, opts), delayMs)
  else play(`fleet-${cue}`, opts)
}
