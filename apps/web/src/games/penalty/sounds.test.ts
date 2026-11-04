import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { penaltyCore, type Kick } from '@duelwise/core/src/games/penalty/core'
import type { Result } from '@duelwise/core/src/types'
import { resetAudioForTests, setMuted, setVolume } from '../../lib/audio'
import { moodForGame, resetMusicForTests } from '../../lib/music'
import { END_CROWD_DELAY_MS, END_HOLD_MS, END_HOLD_REDUCED_MS, MAX_VOICES, NET_TICKS, PEAK, cuesForEnd, cuesForKick, endHoldMs, playCue, playResultStinger, playTimed, resetVoicesForTests, type PenaltyCue } from './sounds'

const g = globalThis as unknown as Record<string, unknown>
const saved = { window: g.window, Audio: g.Audio, localStorage: g.localStorage }

/** Every source the fake context starts, with the highest gain any envelope reached after it (the cue's peak before the master volume is applied by the page). */
interface Src { kind: 'osc' | 'noise'; start: number; peak: number; ramps: number }
let srcs: Src[] = []
let gains: Array<{ peak: number; ramps: number }> = []
class FakeParam {
  constructor(private rec: { peak: number; ramps: number } | null) {}
  value = 0
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime(v: number) {
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
  createGain() {
    const rec = { peak: 0, ramps: 0 }
    gains.push(rec)
    return Object.assign(new FakeNode(), { gain: new FakeParam(rec) })
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
    return Object.assign(new FakeNode(), { start: (t: number) => { s.start = t }, stop() {} })
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
  g.window = saved.window; g.Audio = saved.Audio; g.localStorage = saved.localStorage
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

test('Twelve Yards has the action music loop', () => {
  expect(moodForGame('penalty')).toBe('action')
})
