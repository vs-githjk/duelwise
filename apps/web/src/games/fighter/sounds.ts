import { play, registerSounds } from '../../lib/audio'
import { EV } from '@duelwise/core/src/games/fighter/state.ts'
import type { PresentEvent } from '@duelwise/core/src/netplay/events'
import { playStinger } from '../../lib/music'
import { hitIsHeavy } from './render/present'

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

/**
 * The cues a batch of rollback presentation events asks for (fire only; a sound already playing cannot be taken back, and every cue here
 * plays at once, so a cancel has nothing scheduled to drop). The KO cue comes from a final event, so it only plays from a confirmed
 * frame. 'round' and 'fight' follow phase changes, which the page reads from the confirmed state, not from here.
 */
export function cuesFromEvents(evs: readonly PresentEvent[]): FighterCue[] {
  const out: FighterCue[] = []
  for (const e of evs) {
    if (e.op !== 'fire') continue
    if (e.kind === EV.HIT_TAKEN && !evs.some((o) => o.op === 'fire' && o.frame === e.frame && o.seat === e.seat && o.kind === EV.THROWN)) out.push(e.arg >= 0 && hitIsHeavy(e.arg) ? 'hit-heavy' : 'hit-light')
    else if (e.kind === EV.BLOCKED) out.push('block')
    else if (e.kind === EV.KO) out.push('ko')
  }
  return out
}
