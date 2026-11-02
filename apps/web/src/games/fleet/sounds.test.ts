import { afterEach, beforeEach, expect, test } from 'bun:test'
import { registerSounds, resetAudioForTests, setMuted, setVolume } from '../../lib/audio'
import { playCue, SPLASH_SECONDS } from './sounds'
import { moodForGame } from '../../lib/music'

const g = globalThis as unknown as Record<string, unknown>
const saved = { window: g.window, Audio: g.Audio, localStorage: g.localStorage }

interface Made { started: number; peak: number | null }
let made: Made[] = []
class FakeCtx {
  currentTime = 0
  sampleRate = 1000
  destination = {}
  createBuffer(_c: number, n: number) { return { n, getChannelData: () => new Float32Array(n) } }
  createBufferSource() {
    const m: Made = { started: 0, peak: null }
    made.push(m)
    return { buffer: null as unknown, connect: () => {}, start: () => { m.started++ } }
  }
  createBiquadFilter() {
    return { type: '', frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }
  }
  createGain() {
    const m = made.at(-1)
    return { gain: { setValueAtTime: (v: number) => { if (m && m.peak === null) m.peak = v }, exponentialRampToValueAtTime: () => {} }, connect: () => {} }
  }
}
class FakeAudio {
  paused = true; volume = 1; muted = false; currentTime = 0; preload = ''
  constructor(public src: string) {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}
beforeEach(() => {
  made = []
  g.window = { AudioContext: FakeCtx }
  g.Audio = FakeAudio
  g.localStorage = { getItem: () => null, setItem: () => {} }
  resetAudioForTests()
})
afterEach(() => {
  resetAudioForTests()
  g.window = saved.window; g.Audio = saved.Audio; g.localStorage = saved.localStorage
})

test('every cue is safe to play with no audio device, and fleet has a music mood', () => {
  g.window = {}
  resetAudioForTests()
  for (const c of ['aim', 'fire', 'miss', 'hit', 'sunk', 'win', 'lose'] as const) expect(() => playCue(c)).not.toThrow()
  expect(moodForGame('fleet')).toBe('board')
})

test('a miss is a synthesized splash of 180 ms, not the shot sample', () => {
  expect(SPLASH_SECONDS).toBe(0.18)
  playCue('miss')
  expect(made).toHaveLength(1)
  expect(made[0]!.started).toBe(1)
})

test('the splash follows the master volume and stays silent when sound effects are off', () => {
  setVolume(0.5)
  playCue('miss')
  const loud = made[0]!.peak!
  setVolume(0.25)
  playCue('miss')
  expect(made[1]!.peak!).toBeCloseTo(loud / 2, 6)
  setMuted(true)
  playCue('miss')
  expect(made).toHaveLength(2)
})

test('the sink cue is pitched down to 0.8 and really changes pitch; other cues keep the sample as it is', () => {
  const els: Array<FakeAudio & { playbackRate?: number; preservesPitch?: boolean }> = []
  g.Audio = class extends FakeAudio {
    constructor(src: string) {
      super(src)
      els.push(this)
    }
  }
  // The reset above forgets the module's own registration, so the two cues are registered again under their names.
  registerSounds({ 'fleet-sunk': '/x/confirmation_002.ogg', 'fleet-hit': '/x/impactPlate_medium_000.ogg' })
  playCue('sunk')
  const played = els.find((e) => !e.paused)!
  expect(played.src).toContain('confirmation_002')
  expect(played.playbackRate).toBe(0.8)
  expect(played.preservesPitch).toBe(false)
  els.length = 0
  playCue('hit')
  const hit = els.find((e) => !e.paused)!
  expect(hit.playbackRate).toBeUndefined()
})
