import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { penaltyCore, type Kick } from '@duelwise/core/src/games/penalty/core'
import type { Result } from '@duelwise/core/src/types'
import { resetAudioForTests, setMuted, setVolume } from '../../lib/audio'
import { moodForGame, resetMusicForTests } from '../../lib/music'
import { busActive, silenceAll, CUE_FILES, FILE_GAIN, preloadCueFiles, END_CROWD_DELAY_MS, END_HOLD_MS, END_HOLD_REDUCED_MS, MAX_VOICES, NET_TICKS, PEAK, cuesForEnd, cuesForKick, endHoldMs, playCue, playResultStinger, playTimed, resetVoicesForTests, type PenaltyCue } from './sounds'

const g = globalThis as unknown as Record<string, unknown>
const saved = { window: g.window, Audio: g.Audio, localStorage: g.localStorage, fetch: g.fetch }

/** Every source the fake context starts, with the highest gain any envelope reached after it (the cue's peak before the master volume is applied by the page). */
interface Src { kind: 'osc' | 'noise'; start: number; peak: number; ramps: number; buffer?: unknown }
let srcs: Src[] = []
let failDecode = false
let fetched: string[] = []
let failFetch = false
let gains: Array<{ peak: number; ramps: number }> = []
let allParams: FakeParam[] = []
class FakeParam {
  constructor(private rec: { peak: number; ramps: number } | null) {}
  value = 0
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  times: number[] = []
  exponentialRampToValueAtTime(v: number, t?: number) {
    if (t !== undefined) this.times.push(t)
    if (!this.rec) return
    this.rec.ramps++
    if (v > this.rec.peak) this.rec.peak = v
  }
}
class FakeNode {
  frequency = new FakeParam(null)
  Q = new FakeParam(null)
  type = ''
  buffer: unknown = null
  connect(d: unknown) { return d }
}
class FakeCtx {
  currentTime = 10
  sampleRate = 8000
  state = 'running'
  destination = new FakeNode()
  resume() { return Promise.resolve() }
  createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) } }
  decodeAudioData(bytes: { url: string }) { return failDecode ? Promise.reject(new Error('bad file')) : Promise.resolve({ url: bytes.url, getChannelData: () => new Float32Array(1) }) }
  createGain() {
    const rec = { peak: 0, ramps: 0 }
    gains.push(rec)
    const gain = new FakeParam(rec)
    allParams.push(gain)
    return Object.assign(new FakeNode(), { gain })
  }
  createBiquadFilter() { return new FakeNode() }
  createOscillator() {
    const s: Src = { kind: 'osc', start: -1, peak: 0, ramps: 0 }
    srcs.push(s)
    return Object.assign(new FakeNode(), { start: (t: number) => { s.start = t }, stop() {} })
  }
  createBufferSource() {
    const s: Src = { kind: 'noise', start: -1, peak: 0, ramps: 0 }
    srcs.push(s)
    const node = Object.assign(new FakeNode(), { start: (t: number) => { s.start = t }, stop() {} })
    Object.defineProperty(node, 'buffer', { get: () => s.buffer, set: (b) => { s.buffer = b } })
    return node
  }
}
class FakeAudio {
  paused = true; volume = 1; muted = false; currentTime = 0; preload = ''
  constructor(public src: string) {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}
beforeEach(() => {
  srcs = []
  gains = []
  allParams = []
  failDecode = false
  failFetch = false
  fetched = []
  g.fetch = (url: string) => { fetched.push(url); return failFetch ? Promise.resolve({ ok: false, status: 404 }) : Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve({ url }) }) }
  g.window = { AudioContext: FakeCtx }
  g.Audio = FakeAudio
  g.localStorage = { getItem: () => null, setItem: () => {} }
  resetAudioForTests()
  resetMusicForTests()
  resetVoicesForTests()
})
afterEach(() => {
  resetMusicForTests()
  resetAudioForTests()
  g.fetch = saved.fetch; g.window = saved.window; g.Audio = saved.Audio; g.localStorage = saved.localStorage
})

const kick = (kicker: 0 | 1, outcome: 'goal' | 'save' | 'wide'): Kick => ({ kicker, zone: 4, dive: 0, goal: outcome === 'goal', onTarget: outcome !== 'wide' })
const names = (c: Array<{ cue: PenaltyCue }>) => c.map((x) => x.cue)
const ALL: PenaltyCue[] = ['strike', 'net', 'glove', 'wide', 'whistleStart', 'whistleFull', 'cheer', 'cheerSave', 'cheerBig', 'groan', 'groanBig']

describe('what a kick sounds like', () => {
  test('your goal is the net and a cheer; the opponent\'s goal is the net alone', () => {
    expect(names(cuesForKick(kick(0, 'goal'), 0))).toEqual(['net', 'cheer'])
    expect(names(cuesForKick(kick(1, 'goal'), 0))).toEqual(['net'])
  })
  test('your shot saved or wide groans; your save of theirs gets a small cheer; their miss is quiet', () => {
    expect(names(cuesForKick(kick(0, 'save'), 0))).toEqual(['glove', 'groan'])
    expect(names(cuesForKick(kick(0, 'wide'), 0))).toEqual(['wide', 'groan'])
    expect(names(cuesForKick(kick(1, 'save'), 0))).toEqual(['glove', 'cheerSave'])
    expect(names(cuesForKick(kick(1, 'wide'), 0))).toEqual(['wide'])
  })
  test('the crowd follows the player\'s seat, whichever seat that is', () => {
    expect(names(cuesForKick(kick(1, 'goal'), 1))).toEqual(['net', 'cheer'])
    expect(names(cuesForKick(kick(0, 'goal'), 1))).toEqual(['net'])
  })
  test('the kick that ends the shootout leaves the crowd to full time, so it is never doubled', () => {
    for (const o of ['goal', 'save', 'wide'] as const) for (const k of [0, 1] as const) {
      const c = names(cuesForKick(kick(k, o), 0, { terminal: true }))
      expect(c.some((n) => n.startsWith('cheer') || n.startsWith('groan'))).toBe(false)
      expect(c).toHaveLength(1)
    }
  })
  test('the crowd comes after the ball, never before', () => {
    for (const o of ['goal', 'save', 'wide'] as const) for (const k of [0, 1] as const) for (const c of cuesForKick(kick(k, o), 0)) expect(c.delayMs).toBeGreaterThanOrEqual(0)
    expect(cuesForKick(kick(0, 'goal'), 0).find((c) => c.cue === 'cheer')!.delayMs).toBeGreaterThan(0)
  })
})

describe('full time', () => {
  const win: Result = { winner: 0, score: [3, 2], reason: 'more goals' }
  test('a win is the whistle and the big cheer; a loss the whistle and the big groan; a draw the whistle alone', () => {
    expect(cuesForEnd(win, 0)).toEqual([{ cue: 'whistleFull', delayMs: 0 }, { cue: 'cheerBig', delayMs: END_CROWD_DELAY_MS }])
    expect(names(cuesForEnd(win, 1))).toEqual(['whistleFull', 'groanBig'])
    expect(names(cuesForEnd({ winner: null, score: [4, 4], reason: 'level after sudden death' }, 0))).toEqual(['whistleFull'])
  })
  test('the winning cheer is bigger than the goal cheer, and longer', () => {
    expect(PEAK.cheerBig).toBeGreaterThan(PEAK.cheer)
    expect(PEAK.cheer).toBeGreaterThan(PEAK.cheerSave)
  })
  test('the hold is 1080 ms, and a short beat with reduced motion', () => {
    expect(END_HOLD_MS).toBe(1080)
    expect(endHoldMs(false)).toBe(1080)
    expect(endHoldMs(true)).toBe(END_HOLD_REDUCED_MS)
    expect(END_HOLD_REDUCED_MS).toBeLessThan(END_HOLD_MS)
  })
  test('a real sudden-death shootout ends with the cues for the side that won it', () => {
    // Seed found by walking: a shootout that reaches sudden death.
    let found = false
    for (let seed = 1; seed < 400 && !found; seed++) {
      let s = penaltyCore.init(seed)
      while (!penaltyCore.terminal(s)) {
        const k = s.kicks.length
        s = penaltyCore.step(s, k % 2 === 0 ? [(k >> 1) % 9, 0] as never : [0, (k >> 1) % 9] as never)
      }
      if (s.kicks.length <= 10) continue
      found = true
      const r = penaltyCore.result(s)!
      for (const human of [0, 1] as const) {
        const c = names(cuesForEnd(r, human))
        expect(c).toContain('whistleFull')
        expect(c.includes('cheerBig')).toBe(r.winner === human)
        expect(c.includes('groanBig')).toBe(r.winner !== null && r.winner !== human)
      }
    }
    expect(found).toBe(true)
  })
})

describe('playing', () => {
  test('every cue makes sound when sound is on, and nothing when it is off', () => {
    for (const c of ALL) {
      srcs = []
      resetVoicesForTests()
      playCue(c)
      expect(srcs.length).toBeGreaterThan(0)
    }
    setMuted(true)
    srcs = []
    resetVoicesForTests()
    for (const c of ALL) playCue(c)
    playTimed(cuesForEnd({ winner: 0, score: [3, 2], reason: 'more goals' }, 0))
    expect(srcs).toHaveLength(0)
  })
  test('the master volume scales every envelope, and zero is silent in effect', () => {
    playCue('cheerBig')
    const full = Math.max(...gains.map((x) => x.peak))
    gains = []
    resetVoicesForTests()
    setVolume(0.35)
    playCue('cheerBig')
    const low = Math.max(...gains.map((x) => x.peak))
    expect(low).toBeCloseTo(full * (0.35 / 0.7), 5)
  })
  test('no cue is louder than Stormglass\'s fire shot (about 0.53), and the crowd stays under the ball', () => {
    for (const [k, v] of Object.entries(PEAK)) expect(v).toBeLessThanOrEqual(0.53)
    expect(Math.max(PEAK.cheer, PEAK.cheerBig, PEAK.groan, PEAK.groanBig)).toBeLessThanOrEqual(PEAK.strike)
  })
  test('a net rustle is at most NET_TICKS bursts, and one with reduced motion', () => {
    playCue('net')
    const most = Math.max(...gains.map((x) => x.ramps))
    expect(most).toBeLessThanOrEqual(2 + 2 * NET_TICKS)
    gains = []
    resetVoicesForTests()
    playCue('net', 0, true)
    expect(Math.max(...gains.map((x) => x.ramps))).toBeLessThan(most)
  })
  test('every ramp of the net rustle lands after the cue starts, whatever the context clock says (they used to omit the start time)', () => {
    playCue('net')
    const times = allParams.flatMap((p) => p.times)
    expect(times.length).toBeGreaterThan(3)
    for (const t of times) expect(t, 'a ramp scheduled before the cue began would be skipped once the clock has run').toBeGreaterThan(10)
  })

  test('a cue still ringing is cut when the sound goes off and when a new match or page asks for silence', () => {
    playCue('cheerBig')
    expect(busActive()).toBe(true)
    setMuted(true)
    expect(busActive(), 'muting cuts what is sounding').toBe(false)
    setMuted(false)
    playCue('cheer')
    expect(busActive()).toBe(true)
    silenceAll()
    expect(busActive()).toBe(false)
    playCue('glove')
    expect(busActive(), 'the next cue builds a fresh bus').toBe(true)
  })

  test('a burst never holds more than MAX_VOICES at once, and one whole full time fits', () => {
    for (let i = 0; i < 40; i++) playCue('whistleFull')
    expect(srcs.length).toBeLessThanOrEqual(MAX_VOICES)
    srcs = []
    resetVoicesForTests()
    playTimed(cuesForEnd({ winner: 0, score: [3, 2], reason: 'more goals' }, 0))
    playTimed(cuesForKick(kick(0, 'goal'), 0))
    expect(srcs.length).toBeGreaterThan(0)
    expect(srcs.length).toBeLessThanOrEqual(MAX_VOICES)
  })
  test('every cue is safe with no audio device', () => {
    g.window = {}
    resetAudioForTests()
    resetVoicesForTests()
    for (const c of ALL) expect(() => playCue(c)).not.toThrow()
    expect(() => playResultStinger({ winner: 0, score: [1, 0], reason: 'x' }, 0)).not.toThrow()
  })
  test('win and loss are the shared stingers (they duck the loop); a draw has none', () => {
    playResultStinger({ winner: 0, score: [3, 2], reason: 'more goals' }, 0)
    playResultStinger({ winner: 0, score: [3, 2], reason: 'more goals' }, 1)
    playResultStinger({ winner: null, score: [4, 4], reason: 'level after sudden death' }, 0)
    const events = (g.window as { __duelwiseAudio?: { events: Array<{ type: string; outcome?: string }> } }).__duelwiseAudio!.events.filter((e) => e.type === 'stinger')
    expect(events.map((e) => e.outcome)).toEqual(['win', 'loss'])
  })
})

const settle = () => new Promise((r) => setTimeout(r, 0))
const FILE_CUES = Object.keys(CUE_FILES) as PenaltyCue[]

describe('recorded crowd and whistle', () => {
  test('the crowd and the whistle are files; the ball cues stay synthesised', () => {
    expect(FILE_CUES.sort()).toEqual(['cheer', 'cheerBig', 'cheerSave', 'groan', 'groanBig', 'whistleFull', 'whistleStart'])
    for (const c of ['strike', 'net', 'glove', 'wide'] as PenaltyCue[]) expect(CUE_FILES[c]).toBeUndefined()
    for (const [cue, url] of Object.entries(CUE_FILES)) expect(url).toMatch(new RegExp(`/assets/audio/opengameart/crowd/${cue}\\.mp3$`))
  })
  test('nothing is fetched until a cue or the page asks, and then each file once', async () => {
    expect(fetched).toHaveLength(0)
    preloadCueFiles()
    preloadCueFiles()
    await settle()
    expect(fetched.sort()).toEqual(Object.values(CUE_FILES).sort())
  })
  test('no fetch while sound is off', async () => {
    setMuted(true)
    preloadCueFiles()
    await settle()
    expect(fetched).toHaveLength(0)
  })
  test('once loaded, each cue plays its own file and no synthesised tone', async () => {
    preloadCueFiles()
    await settle()
    for (const c of FILE_CUES) {
      srcs = []
      resetVoicesForTests()
      playCue(c)
      expect(srcs, c).toHaveLength(1)
      expect(srcs[0]!.kind).toBe('noise')
      expect((srcs[0]!.buffer as { url: string }).url).toBe(String(CUE_FILES[c]))
    }
  })
  test('the recordings sit under the boot: gain times a full-scale file never passes the strike peak', () => {
    for (const g2 of Object.values(FILE_GAIN)) expect(g2).toBeLessThanOrEqual(0.7)
    for (const c of FILE_CUES) expect(FILE_GAIN[c], c).toBeDefined()
  })
  test('a recording is cut by muting, like every cue', async () => {
    preloadCueFiles()
    await settle()
    playCue('cheerBig')
    expect(busActive()).toBe(true)
    setMuted(true)
    expect(busActive()).toBe(false)
    srcs = []
    playCue('cheerBig')
    expect(srcs).toHaveLength(0)
  })
  test('before the files arrive, a cue is the synthesised one', () => {
    playCue('whistleFull')
    expect(srcs.some((s) => s.kind === 'osc')).toBe(true)
    srcs = []
    resetVoicesForTests()
    playCue('cheer')
    expect(srcs.some((s) => s.kind === 'noise')).toBe(true)
    expect(srcs.every((s) => s.buffer !== undefined && (s.buffer as { url?: string }).url === undefined)).toBe(true)
  })
  test('a file that will not load falls back to the synth, quietly', async () => {
    failFetch = true
    preloadCueFiles()
    await settle()
    for (const c of FILE_CUES) expect(() => playCue(c)).not.toThrow()
    expect(srcs.length).toBeGreaterThan(0)
    expect(srcs.every((s) => (s.buffer as { url?: string } | undefined)?.url === undefined)).toBe(true)
  })
  test('a file that will not decode falls back too', async () => {
    failDecode = true
    preloadCueFiles()
    await settle()
    playCue('whistleStart')
    expect(srcs.some((s) => s.kind === 'osc')).toBe(true)
  })
  test('a context with no decoder or no fetch plays the synth and never throws', () => {
    g.fetch = undefined
    expect(() => preloadCueFiles()).not.toThrow()
    playCue('groan')
    expect(srcs.length).toBeGreaterThan(0)
  })
})

test('Twelve Yards has the action music loop', () => {
  expect(moodForGame('penalty')).toBe('action')
})
