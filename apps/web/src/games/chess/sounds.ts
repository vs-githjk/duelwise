import { play, registerSounds } from '../../lib/audio'

// Kenney Interface Sounds and Impact Sounds (CC0), saved under public/assets/ui/kenney with their licence files.
const BASE = '/assets/ui/kenney'

registerSounds({
  'chess-move': `${BASE}/impact-sounds/impactPlate_light_000.ogg`,
  'chess-capture': `${BASE}/impact-sounds/impactPlate_medium_000.ogg`,
  'chess-check': `${BASE}/interface-sounds/toggle_002.ogg`,
  'chess-win': `${BASE}/interface-sounds/confirmation_002.ogg`,
  'chess-lose': `${BASE}/interface-sounds/error_004.ogg`,
  'chess-draw': `${BASE}/interface-sounds/toggle_002.ogg`,
  'chess-reject': `${BASE}/interface-sounds/tick_002.ogg`,
})

export type ChessCue = 'move' | 'capture' | 'check' | 'win' | 'lose' | 'draw' | 'reject'

/** Plays one cue through the shared helper, so mute and volume apply. Silent when blocked; never throws. */
export function playCue(cue: ChessCue, delayMs = 0): void {
  if (delayMs > 0) setTimeout(() => play(`chess-${cue}`), delayMs)
  else play(`chess-${cue}`)
}
