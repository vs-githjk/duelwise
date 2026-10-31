import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getVolume, isMuted, play, primeAudio, registerSounds, resetAudioForTests, setMuted, setVolume, subscribeAudio } from './audio'

const g = globalThis as unknown as { localStorage?: unknown }
const original = g.localStorage

function fakeStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

beforeEach(() => resetAudioForTests())
afterEach(() => {
  g.localStorage = original
  resetAudioForTests()
})

describe('audio preferences', () => {
  test('volume and mute persist across a reload', () => {
    const store = fakeStorage()
    g.localStorage = store
    setVolume(0.3)
    setMuted(true)
    resetAudioForTests()
    expect(getVolume()).toBe(0.3)
    expect(isMuted()).toBe(true)
    expect(JSON.parse(store.data.get('duelwise.audio')!)).toEqual({ volume: 0.3, muted: true })
  })

  test('volume is clamped and subscribers hear changes', () => {
    g.localStorage = fakeStorage()
    let calls = 0
    const off = subscribeAudio(() => calls++)
    setVolume(5)
    expect(getVolume()).toBe(1)
    setVolume(-1)
    expect(getVolume()).toBe(0)
    off()
    setMuted(false)
    expect(calls).toBe(2)
  })

  test('works when storage throws or holds junk', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(getVolume()).toBe(0.7)
    expect(() => setMuted(true)).not.toThrow()
    expect(isMuted()).toBe(true)
    resetAudioForTests()
    g.localStorage = fakeStorage({ 'duelwise.audio': '{not json' })
    expect(getVolume()).toBe(0.7)
  })
})

describe('primeAudio (the Start tap unlocks sound for the auto-start after a rotation)', () => {
  const w = globalThis as unknown as Record<string, unknown>
  const saved = { window: w.window, Audio: w.Audio, localStorage: w.localStorage }
  afterEach(() => {
    w.window = saved.window
    w.Audio = saved.Audio
    w.localStorage = saved.localStorage
  })

  test('resumes one AudioContext, starts every pooled element muted, and later cues play through those same elements', async () => {
    const calls = { resume: 0, started: 0, played: [] as string[], made: [] as unknown[] }
    class FakeCtx {
      destination = {}
      resume() { calls.resume++; return Promise.resolve() }
      createBuffer() { return {} }
      createBufferSource() { return { buffer: null, connect() {}, start() { calls.started++ } } }
    }
    class FakeAudio {
      muted = false; currentTime = 1; preload = ''; paused = true; ended = false; volume = 1
      constructor(public src: string) { calls.made.push(this) }
      play() { calls.played.push(`${this.src}:${this.muted ? 'muted' : 'loud'}`); this.paused = false; return Promise.resolve() }
      pause() { this.paused = true }
      cloneNode(): never { throw new Error('a cue must never play through a clone') }
    }
    w.window = { AudioContext: FakeCtx }
    w.Audio = FakeAudio
    g.localStorage = fakeStorage()
    registerSounds({ a: '/a.ogg', b: '/b.ogg' })
    primeAudio()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls.resume).toBe(1)
    expect(calls.started).toBe(1)
    expect(calls.made.length).toBe(6) // three elements per sound
    expect(calls.played.length).toBe(6)
    expect(calls.played.every((x) => x.endsWith(':muted'))).toBe(true)
    // A real cue after the unlock: no new element is made, and the one that plays is one that was unlocked.
    calls.played.length = 0
    play('a')
    expect(calls.made.length).toBe(6)
    expect(calls.played).toEqual(['/a.ogg:loud'])
  })

  test('never throws without Web Audio or Audio', () => {
    w.window = {}
    w.Audio = undefined
    expect(() => primeAudio()).not.toThrow()
  })
})
