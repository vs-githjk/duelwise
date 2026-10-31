import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isMusicOn, isMuted, resetAudioForTests, setMusicOn, setMuted, setVolume, getVolume } from './audio'
import { DUCK_LEVEL, MUSIC_LEVEL, TRACKS, duckMusic, moodForPath, musicState, playStinger, resetMusicForTests, setMood, startMusic, tickMusic, unlockMusic } from './music'

const g = globalThis as unknown as Record<string, unknown>
const saved = { window: g.window, document: g.document, Audio: g.Audio, localStorage: g.localStorage }

function fakeStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

interface El {
  src: string
  loop: boolean
  paused: boolean
  volume: number
  muted: boolean
  currentTime: number
  plays: number
  refuse: string | null
}
let els: El[] = []
let refuse: string | null = null

class FakeAudio implements El {
  loop = false; paused = true; volume = 1; muted = false; currentTime = 0; preload = ''; plays = 0; refuse: string | null = null
  constructor(public src: string) { els.push(this); this.refuse = refuse }
  play() {
    this.plays++
    if (this.refuse) return Promise.reject(Object.assign(new Error('blocked'), { name: this.refuse }))
    this.paused = false
    return Promise.resolve()
  }
  pause() { this.paused = true }
}

function fakeBrowser() {
  const handlers = new Map<string, Set<(e?: unknown) => void>>()
  const add = (type: string, fn: (e?: unknown) => void) => { (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(fn) }
  const remove = (type: string, fn: (e?: unknown) => void) => void handlers.get(type)?.delete(fn)
  const fire = (type: string) => { for (const fn of [...(handlers.get(type) ?? [])]) fn({ type }) }
  const doc = { visibilityState: 'visible', addEventListener: add, removeEventListener: remove }
  g.document = doc
  g.window = { addEventListener: add, removeEventListener: remove }
  return { fire, doc, count: (t: string) => handlers.get(t)?.size ?? 0 }
}

beforeEach(() => {
  els = []
  refuse = null
  g.Audio = FakeAudio
  g.localStorage = fakeStorage()
  resetAudioForTests()
  resetMusicForTests()
})
afterEach(() => {
  resetMusicForTests()
  resetAudioForTests()
  g.window = saved.window
  g.document = saved.document
  g.Audio = saved.Audio
  g.localStorage = saved.localStorage
})

describe('mood for a page', () => {
  test('the lobby everywhere outside a match, the game mood on a game page', () => {
    for (const p of ['/', '/play', '/leaderboard/chess', '/ai', '/settings', '/play/not-a-game']) expect(moodForPath(p)).toBe('lobby')
    for (const p of ['/play/chess', '/play/four-in-a-row', '/play/word-duel']) expect(moodForPath(p)).toBe('board')
    expect(moodForPath('/play/heads-up-holdem')).toBe('poker')
    for (const p of ['/play/tinderbox', '/play/coldstore']) expect(moodForPath(p)).toBe('action')
  })
})

describe('music and sound effects settings', () => {
  test('music defaults on, the switches are separate, and both persist across a reload', () => {
    const store = fakeStorage()
    g.localStorage = store
    expect(isMusicOn()).toBe(true)
    expect(isMuted()).toBe(false)
    setMusicOn(false)
    expect(isMuted()).toBe(false)
    setMuted(true)
    expect(isMusicOn()).toBe(false)
    resetAudioForTests()
    expect(isMusicOn()).toBe(false)
    expect(isMuted()).toBe(true)
    setMusicOn(true)
    resetAudioForTests()
    expect(isMusicOn()).toBe(true)
    expect(isMuted()).toBe(true)
    expect(JSON.parse(store.data.get('duelwise.audio')!).music).toBe(true)
  })

  test('an older saved choice without the music field keeps music on; storage that throws does not break the switches', () => {
    g.localStorage = fakeStorage({ 'duelwise.audio': '{"volume":0.4,"muted":true}' })
    expect(isMusicOn()).toBe(true)
    expect(getVolume()).toBe(0.4)
    resetAudioForTests()
    g.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(() => setMusicOn(false)).not.toThrow()
    expect(isMusicOn()).toBe(false)
  })
})

describe('gestures', () => {
  test('nothing is created or played before the first tap; the tap starts the loop for the current mood at the low level', () => {
    fakeBrowser()
    const stop = startMusic()
    setMood('board')
    expect(els.length).toBe(0)
    expect(musicState().gestured).toBe(false)
    unlockMusic()
    expect(els.length).toBe(1)
    expect(els[0]!.src).toBe(TRACKS.board)
    expect(els[0]!.loop).toBe(true)
    expect(els[0]!.paused).toBe(false)
    tickMusic(5000)
    expect(els[0]!.volume).toBeCloseTo(getVolume() * MUSIC_LEVEL, 5)
    stop()
  })

  test('the first tap, click or key press unlocks it through the listeners, then they are removed', () => {
    const b = fakeBrowser()
    const stop = startMusic()
    expect(b.count('pointerup')).toBe(1)
    b.fire('keydown')
    expect(els.length).toBe(1)
    expect(b.count('pointerup') + b.count('click') + b.count('touchend') + b.count('keydown')).toBe(0)
    stop()
  })

  test('a tap the browser refuses (NotAllowedError) waits for the next tap', async () => {
    const b = fakeBrowser()
    refuse = 'NotAllowedError'
    const stop = startMusic()
    b.fire('pointerup')
    await Promise.resolve(); await Promise.resolve()
    expect(musicState().gestured).toBe(false)
    expect(b.count('click')).toBe(1) // armed again
    els[0]!.refuse = null // the same element is tried again
    b.fire('click')
    expect(els.length).toBe(1)
    expect(els[0]!.paused).toBe(false)
    expect(musicState().gestured).toBe(true)
    stop()
  })

  test('with music off a tap starts nothing, and switching it on afterwards starts the loop', () => {
    const b = fakeBrowser()
    setMusicOn(false)
    const stop = startMusic()
    b.fire('pointerup')
    expect(els.length).toBe(0)
    setMusicOn(true)
    expect(els.length).toBe(1)
    expect(els[0]!.paused).toBe(false)
    stop()
  })

  test('switching music off fades the loop out and pauses it', () => {
    const b = fakeBrowser()
    const stop = startMusic()
    b.fire('pointerup')
    tickMusic(2000)
    expect(musicState().playing.lobby).toBe(1)
    setMusicOn(false)
    tickMusic(400)
    expect(els[0]!.paused).toBe(false) // still fading
    tickMusic(2000)
    expect(els[0]!.paused).toBe(true)
    stop()
  })

  test('a hidden tab pauses at once and the loop returns when the tab is back', () => {
    const b = fakeBrowser()
    const stop = startMusic()
    b.fire('pointerup')
    tickMusic(2000)
    b.doc.visibilityState = 'hidden'
    b.fire('visibilitychange')
    expect(els[0]!.paused).toBe(true)
    expect(musicState().hidden).toBe(true)
    b.doc.visibilityState = 'visible'
    b.fire('visibilitychange')
    expect(els[0]!.paused).toBe(false)
    expect(musicState().playing.lobby).toBe(0)
    tickMusic(2000)
    expect(musicState().playing.lobby).toBe(1)
    stop()
  })
})

describe('crossfade', () => {
  test('moving to a game fades the lobby out while the game loop fades in, then the lobby is paused', () => {
    const b = fakeBrowser()
    const stop = startMusic()
    b.fire('pointerup')
    tickMusic(2000)
    setMood('action')
    expect(els.map((e) => e.src)).toEqual([TRACKS.lobby, TRACKS.action])
    tickMusic(750)
    const mid = musicState().playing
    expect(mid.lobby).toBeCloseTo(0.5, 2)
    expect(mid.action).toBeCloseTo(0.5, 2)
    expect(els[0]!.volume).toBeCloseTo(0.5 * getVolume() * MUSIC_LEVEL, 5)
    tickMusic(1000)
    expect(els[0]!.paused).toBe(true)
    expect(els[1]!.volume).toBeCloseTo(getVolume() * MUSIC_LEVEL, 5)
    // And back: the lobby element is reused, not made again.
    setMood('lobby')
    expect(els.length).toBe(2)
    stop()
  })
})

describe('ducking', () => {
  test('a hold lowers the music and releasing brings it back; holds stack', () => {
    const b = fakeBrowser()
    const stop = startMusic()
    b.fire('pointerup')
    tickMusic(2000)
    const full = getVolume() * MUSIC_LEVEL
    const a = duckMusic()
    const c = duckMusic()
    tickMusic(1000)
    expect(musicState().duck).toBeCloseTo(DUCK_LEVEL, 5)
    expect(els[0]!.volume).toBeCloseTo(full * DUCK_LEVEL, 5)
    a()
    a() // a second release of the same hold is harmless
    tickMusic(1000)
    expect(musicState().duck).toBeCloseTo(DUCK_LEVEL, 5) // still held by the other
    c()
    tickMusic(2000)
    expect(musicState().duck).toBe(1)
    expect(els[0]!.volume).toBeCloseTo(full, 5)
    stop()
  })

  test('a result stinger ducks the music and the master volume still scales it', () => {
    const b = fakeBrowser()
    setVolume(0.5)
    const stop = startMusic()
    b.fire('pointerup')
    tickMusic(2000)
    playStinger('win')
    tickMusic(1000)
    expect(musicState().duck).toBeCloseTo(DUCK_LEVEL, 5)
    expect(els[0]!.volume).toBeCloseTo(0.5 * MUSIC_LEVEL * DUCK_LEVEL, 5)
    stop()
  })
})

describe('stingers', () => {
  const hookOf = () => (g.window as { __duelwiseAudio?: { events: Array<{ type: string; outcome?: string; played?: boolean }> } }).__duelwiseAudio!

  test('a win and a loss are recorded for the test hook and played through the sound pool', () => {
    const b = fakeBrowser()
    const stop = startMusic()
    playStinger('win')
    playStinger('loss')
    const events = hookOf().events.filter((e) => e.type === 'stinger')
    expect(events).toEqual([
      { type: 'stinger', outcome: 'win', played: true },
      { type: 'stinger', outcome: 'loss', played: true },
    ])
    // The cues went through the shared helper's elements (the stinger files), not through the music loops.
    expect(els.map((e) => e.src).some((s) => s.endsWith('/stingers/win.mp3'))).toBe(true)
    expect(els.map((e) => e.src).some((s) => s.endsWith('/stingers/loss.mp3'))).toBe(true)
    void b
    stop()
  })

  test('with sound effects off the stinger is recorded as not played, makes no sound and does not duck', () => {
    fakeBrowser()
    const stop = startMusic()
    setMuted(true)
    playStinger('loss')
    expect(hookOf().events.at(-1)).toEqual({ type: 'stinger', outcome: 'loss', played: false })
    expect(els.length).toBe(0)
    expect(musicState().duck).toBe(1)
    stop()
  })
})

describe('the Start tap', () => {
  test('the music unlock and primeAudio on the same tap resume the shared AudioContext once', async () => {
    const { primeAudio } = await import('./audio')
    let resumes = 0
    class FakeCtx {
      destination = {}
      resume() { resumes++; return Promise.resolve() }
      createBuffer() { return {} }
      createBufferSource() { return { buffer: null, connect() {}, start() {} } }
      createGain() { return { gain: { value: 0 }, connect() {} } }
      createMediaElementSource() { return { connect() {} } }
    }
    const b = fakeBrowser()
    ;(g.window as Record<string, unknown>).AudioContext = FakeCtx
    const stop = startMusic()
    b.fire('click') // the capture handler: music unlock
    primeAudio() // then the game's own Start handler
    expect(resumes).toBe(1)
    // The loop is routed through a gain node on that context (iOS ignores element volume), so the element itself stays at full.
    expect(els[0]!.volume).toBe(1)
    stop()
  })
})
