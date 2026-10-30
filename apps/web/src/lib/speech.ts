import { VOICE_KEY } from './progress'
import { isMuted } from './audio'

/**
 * The opponent's line, spoken with the browser's own speech (Web Speech API). No keys, no network, no files.
 * It does nothing where speech is missing, while the site is muted, or while the voice preference is off. Browsers block speech until the
 * player has clicked something, so the preference only turns on after the first click anywhere in the app; before that the line is text only.
 */

type Synth = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'> & { addEventListener?: SpeechSynthesis['addEventListener'] }

const synth = (): Synth | null => (typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined' ? window.speechSynthesis : null)

export const speechSupported = (): boolean => synth() !== null

export type VoicePref = 'on' | 'off' | 'unset'

export function readVoicePref(): VoicePref {
  try {
    const v = window.localStorage.getItem(VOICE_KEY)
    return v === 'on' || v === 'off' ? v : 'unset'
  } catch {
    return 'unset'
  }
}
export function writeVoicePref(v: 'on' | 'off'): void {
  try {
    window.localStorage.setItem(VOICE_KEY, v)
  } catch {}
}

/** The first click anywhere switches the default to on (unless the player already chose), which is the gesture speech needs. */
let armed = false
export function armVoiceOnFirstClick(): void {
  if (armed || typeof window === 'undefined') return
  armed = true
  window.addEventListener(
    'pointerdown',
    () => {
      if (readVoicePref() === 'unset') writeVoicePref('on')
    },
    { once: true, capture: true },
  )
}

/** Whether a line would be spoken right now. */
export function voiceActive(): boolean {
  return speechSupported() && !isMuted() && readVoicePref() === 'on'
}

const PREFERRED = /natural|premium|enhanced|samantha|daniel|google us english/i

/** An English voice that sounds good if there is one, else the first English voice, else the default. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang))
  return en.find((v) => PREFERRED.test(v.name)) ?? en[0] ?? null
}

export function cancelSpeech(): void {
  try {
    synth()?.cancel()
  } catch {}
}

/** Speaks one line once. Voices load late in some browsers, so an empty list waits for `voiceschanged` one time. */
export function speakLine(text: string, opts: { force?: boolean } = {}): boolean {
  const s = synth()
  if (!s || text.trim() === '') return false
  if (!opts.force && !voiceActive()) return false
  if (isMuted()) return false
  let done = false
  const say = () => {
    if (done) return
    done = true
    try {
      s.cancel()
      const u = new SpeechSynthesisUtterance(text)
      const v = pickVoice(s.getVoices())
      if (v) {
        u.voice = v
        u.lang = v.lang
      }
      u.rate = 1
      u.pitch = 1
      s.speak(u)
    } catch {}
  }
  if (s.getVoices().length === 0 && s.addEventListener) {
    // Some browsers fill the voice list late: wait for it, but never longer than a moment.
    s.addEventListener('voiceschanged', say, { once: true })
    setTimeout(say, 400)
  } else say()
  return true
}
