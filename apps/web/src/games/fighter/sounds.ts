import { play, registerSounds } from '../../lib/audio'
import { playStinger } from '../../lib/music'

// Kenney Interface Sounds and Impact Sounds (CC0), already saved under public/assets/ui/kenney with their
// licence files. There is no dedicated combat sample pack yet, so hits reuse the two impact plates;
// a richer set can replace this map without touching the page.
const BASE = '/assets/ui/kenney'

registerSounds({
  'fighter-hit-light': `${BASE}/impact-sounds/impactPlate_light_000.ogg`,
  'fighter-hit-heavy': `${BASE}/impact-sounds/impactPlate_medium_000.ogg`,
  'fighter-block': `${BASE}/interface-sounds/tick_002.ogg`,
  'fighter-ko': `${BASE}/impact-sounds/impactPlate_medium_000.ogg`,
  'fighter-round': `${BASE}/interface-sounds/toggle_002.ogg`,
  'fighter-fight': `${BASE}/interface-sounds/confirmation_002.ogg`,
})

export type FighterCue = 'hit-light' | 'hit-heavy' | 'block' | 'ko' | 'round' | 'fight' | 'win' | 'lose'

/** Plays one cue through the shared helper, so mute and volume apply. Silent when blocked; never throws. */
export function playCue(cue: FighterCue, delayMs = 0): void {
  // The result sounds are the shared win and loss stingers (lib/music.ts), which also duck the music.
  if (cue === 'win' || cue === 'lose') return playStinger(cue === 'win' ? 'win' : 'loss', delayMs)
  if (delayMs > 0) setTimeout(() => play(`fighter-${cue}`), delayMs)
  else play(`fighter-${cue}`)
}
