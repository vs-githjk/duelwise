import { afterEach, beforeEach, expect, test } from 'bun:test'
import { pickVoice, speakLine, speechSupported, voiceActive } from './speech'

const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice
let spoken: string[] = []
const store = new Map<string, string>()

beforeEach(() => {
  spoken = []
  store.clear()
  const g = globalThis as Record<string, unknown>
  g.window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    speechSynthesis: { speak: (u: { text: string }) => spoken.push(u.text), cancel() {}, getVoices: () => [voice('Daniel', 'en-GB')] },
  }
  g.localStorage = (g.window as { localStorage: unknown }).localStorage
  g.SpeechSynthesisUtterance = class { text: string; constructor(t: string) { this.text = t } }
})
afterEach(() => {
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.localStorage
  delete g.SpeechSynthesisUtterance
})

test('voice choice prefers a natural English voice, then any English, then the default', () => {
  expect(pickVoice([voice('Anna', 'de-DE'), voice('Alex', 'en-US'), voice('Samantha', 'en-US')])?.name).toBe('Samantha')
  expect(pickVoice([voice('Anna', 'de-DE'), voice('Alex', 'en-US')])?.name).toBe('Alex')
  expect(pickVoice([voice('Anna', 'de-DE')])).toBeNull()
})
test('nothing is spoken until the voice preference is on, and never while muted', () => {
  expect(speechSupported()).toBe(true)
  expect(voiceActive()).toBe(false)
  expect(speakLine('hello')).toBe(false)
  store.set('duelwise.voice', 'on')
  expect(voiceActive()).toBe(true)
  expect(speakLine('hello')).toBe(true)
  expect(spoken).toEqual(['hello'])
  store.set('duelwise.audio', JSON.stringify({ volume: 0.7, muted: true }))
})
test('a missing speech engine makes every call a no-op', () => {
  delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance
  expect(speechSupported()).toBe(false)
  expect(speakLine('hello', { force: true })).toBe(false)
})
