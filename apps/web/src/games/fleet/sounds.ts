import { play, registerSounds } from '../../lib/audio'
import { moodForGame, playStinger, setMatchMusic } from '../../lib/music'

// Stormglass cues (design spec 2.8). Kenney Interface Sounds and Impact Sounds (CC0), saved under public/assets/ui/kenney
// with their licence files. No water sample is in the repo, so a miss uses the light plate hit at a lower gain.
const BASE = '/assets/ui/kenney'

registerSounds({
  'fleet-aim': `${BASE}/interface-sounds/tick_002.ogg`,
  'fleet-fire': `${BASE}/impact-sounds/impactPlate_light_000.ogg`,
  'fleet-miss': `${BASE}/impact-sounds/impactPlate_light_000.ogg`,
  'fleet-hit': `${BASE}/impact-sounds/impactPlate_medium_000.ogg`,
  'fleet-sunk': `${BASE}/interface-sounds/confirmation_002.ogg`,
})

export type FleetCue = 'aim' | 'fire' | 'miss' | 'hit' | 'sunk' | 'win' | 'lose'

/** Gain per cue; a cue for the opponent's shot passes its own gain on top. */
const GAIN: Record<string, number> = { aim: 0.6, fire: 0.6, miss: 0.5 }

/** Plays one cue through the shared helper, so mute and volume apply. Silent when blocked; never throws. */
export function playCue(cue: FleetCue, gain = 1, delayMs = 0): void {
  // The result sounds are the shared win and loss stingers (lib/music.ts), which also duck the music.
  if (cue === 'win' || cue === 'lose') return playStinger(cue === 'win' ? 'win' : 'loss', delayMs)
  const g = (GAIN[cue] ?? 1) * gain
  if (delayMs > 0) setTimeout(() => play(`fleet-${cue}`, { gain: g }), delayMs)
  else play(`fleet-${cue}`, { gain: g })
}

/** Match music: the board loop while a match is on, silence otherwise. Returns the cleanup. */
export function setFleetMusic(on: boolean): () => void {
  setMatchMusic(on ? moodForGame('fleet') : null)
  return () => setMatchMusic(null)
}
