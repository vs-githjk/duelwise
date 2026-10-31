import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetAudioForTests } from '../lib/audio'
import { resetMusicForTests } from '../lib/music'
import { playCue as chess } from './chess/sounds'
import { playCue as four } from './four/sounds'
import { playCue as fighter } from './fighter/sounds'
import { playCue as holdem } from './holdem/sounds'
import { playCue as word } from './word/sounds'

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

const games = { chess, four, fighter, holdem, word } as Record<string, (cue: 'win' | 'lose') => void>
for (const [name, cue] of Object.entries(games)) {
  test(`${name}: win and lose play the shared stingers`, () => {
    cue('win')
    cue('lose')
    const events = (g.window as Hooked).__duelwiseAudio!.events.filter((e) => e.type === 'stinger')
    expect(events.map((e) => e.outcome)).toEqual(['win', 'loss'])
  })
}
