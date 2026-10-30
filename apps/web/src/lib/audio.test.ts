import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getVolume, isMuted, primeAudio, registerSounds, resetAudioForTests, setMuted, setVolume, subscribeAudio } from './audio'

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
  test('resumes one AudioContext and plays each registered sound once, muted, then restores it', async () => {
    const calls = { resume: 0, started: 0, played: [] as string[] }
    const w = globalThis as unknown as Record<string, unknown>
    const saved = { window: w.window, Audio: w.Audio }
    class FakeCtx {
      destination = {}
      resume() { calls.resume++; return Promise.resolve() }
      createBuffer() { return {} }
      createBufferSource() { return { buffer: null, connect() {}, start() { calls.started++ } } }
    }
    class FakeAudio {
      muted = false; currentTime = 1; preload = ''
      constructor(public src: string) {}
      play() { calls.played.push(`${this.src}:${this.muted ? 'muted' : 'loud'}`); return Promise.resolve() }
      pause() {}
      cloneNode() { return this }
    }
    w.window = { AudioContext: FakeCtx }
    w.Audio = FakeAudio
    try {
      registerSounds({ a: '/a.ogg', b: '/b.ogg' })
      primeAudio()
      primeAudio()
      await Promise.resolve()
      expect(calls.resume).toBe(2)
      expect(calls.started).toBe(2)
      expect(calls.played).toEqual(['/a.ogg:muted', '/b.ogg:muted', '/a.ogg:muted', '/b.ogg:muted'])
    } finally {
      w.window = saved.window
      w.Audio = saved.Audio
    }
  })

  test('never throws without Web Audio or Audio', () => {
    const w = globalThis as unknown as Record<string, unknown>
    const saved = { window: w.window, Audio: w.Audio }
    w.window = {}
    w.Audio = undefined
    try {
      expect(() => primeAudio()).not.toThrow()
    } finally {
      w.window = saved.window
      w.Audio = saved.Audio
    }
  })
})
