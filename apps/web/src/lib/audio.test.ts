import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getVolume, isMuted, resetAudioForTests, setMuted, setVolume, subscribeAudio } from './audio'

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
