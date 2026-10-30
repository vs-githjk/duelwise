import { play, registerSounds } from '../../lib/audio'

// Kenney Interface Sounds and Impact Sounds (CC0), saved under public/assets/ui/kenney with their licence files.
const BASE = '/assets/ui/kenney'

registerSounds({
  'four-drop-you': `${BASE}/impact-sounds/impactPlate_medium_000.ogg`,
  'four-drop-ai': `${BASE}/impact-sounds/impactPlate_light_000.ogg`,
  'four-win': `${BASE}/interface-sounds/confirmation_002.ogg`,
  'four-lose': `${BASE}/interface-sounds/error_004.ogg`,
  'four-draw': `${BASE}/interface-sounds/toggle_002.ogg`,
  'four-reject': `${BASE}/interface-sounds/tick_002.ogg`,
})

export type FourCue = 'drop-you' | 'drop-ai' | 'win' | 'lose' | 'draw' | 'reject'

/** Plays one cue through the shared helper, so mute and volume apply. Silent when blocked; never throws. */
export function playCue(cue: FourCue, delayMs = 0): void {
  if (delayMs > 0) setTimeout(() => play(`four-${cue}`), delayMs)
  else play(`four-${cue}`)
}
