import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetAudioForTests } from '../lib/audio'
import { resetMusicForTests } from '../lib/music'
import { playCue as chess } from './chess/sounds'
import { playCue as four } from './four/sounds'
import { playCue as fighter } from './fighter/sounds'
import { playCue as holdem } from './holdem/sounds'
import { playCue as word } from './word/sounds'
import { playCue as fleet } from './fleet/sounds'

// Every game's win and lose cue is the shared result stinger (lib/music.ts), so the music ducks under it. The draw cue stays the game's own.
const g = globalThis as unknown as Record<string, unknown>
const saved = { window: g.window, Audio: g.Audio, localStorage: g.localStorage }
class FakeAudio {
  paused = true; volume = 1; muted = false; currentTime = 0; preload = ''
  constructor(public src: string) {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}
type Hooked = { __duelwiseAudio?: { events: Array<{ type: string; outcome?: string }> } }
beforeEach(() => {
  g.window = {}
  g.Audio = FakeAudio
  g.localStorage = { getItem: () => null, setItem: () => {} }
  resetAudioForTests()
  resetMusicForTests()
})
afterEach(() => {
  resetMusicForTests()
  resetAudioForTests()
  g.window = saved.window; g.Audio = saved.Audio; g.localStorage = saved.localStorage
})

const games = { chess, four, fighter, holdem, word, fleet } as Record<string, (cue: 'win' | 'lose') => void>
for (const [name, cue] of Object.entries(games)) {
  test(`${name}: win and lose play the shared stingers`, () => {
    cue('win')
    cue('lose')
    const events = (g.window as Hooked).__duelwiseAudio!.events.filter((e) => e.type === 'stinger')
    expect(events.map((e) => e.outcome)).toEqual(['win', 'loss'])
  })
}

test('turning Sound effects off cancels a spoken line, and a line waiting for voices is dropped', async () => {
  const { setMuted } = await import('../lib/audio')
  const { speakLine } = await import('../lib/speech')
  const calls = { cancel: 0, speak: 0 }
  const holder: { ready: (() => void) | null } = { ready: null }
  let voices: unknown[] = []
  class Utter { constructor(public text: string) {} }
  g.SpeechSynthesisUtterance = Utter
  g.window = {
    speechSynthesis: {
      speak: () => void calls.speak++,
      cancel: () => void calls.cancel++,
      getVoices: () => voices,
      addEventListener: (_t: string, fn: () => void) => { holder.ready = fn },
    },
  }
  g.localStorage = { getItem: () => null, setItem: () => {} }
  resetAudioForTests()
  expect(speakLine('hello', { force: true })).toBe(true) // waits for voices
  setMuted(true) // muted before the voices arrive
  holder.ready?.()
  expect(calls.speak).toBe(0)
  // A line already being spoken is cancelled the moment sound effects go off.
  setMuted(false)
  voices = [{ lang: 'en-US', name: 'x' }]
  expect(speakLine('again', { force: true })).toBe(true)
  expect(calls.speak).toBe(1)
  const before = calls.cancel
  setMuted(true)
  expect(calls.cancel).toBe(before + 1)
})
