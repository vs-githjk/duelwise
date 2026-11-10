import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { blankState, type PuckState } from '@duelwise/core/src/games/puck/state'
import { GOALS_TO_WIN, MALLET_R, PUCK_EVENTS, PUCK_MAX_SPEED, PUCK_R } from '@duelwise/core/src/games/puck/constants'
import { resetAudioForTests, setMuted, setVolume } from '../../lib/audio'
import { moodForGame, resetMusicForTests } from '../../lib/music'
import { HIT_GAP_MS, MAX_VOICES, PEAK, cuesForTick, hitGain, playPuckCue, playResult, resetVoicesForTests, snapOf, type CueReq } from './sounds'

const g = globalThis as unknown as Record<string, unknown>
const saved = { window: g.window, Audio: g.Audio, localStorage: g.localStorage }

interface Osc { type: string; f0: number; start: number; peak: number }
let oscs: Osc[] = []
class FakeCtx {
  currentTime = 10
  state = 'running'
  destination = {}
  resume() { return Promise.resolve() }
  createGain() {
    const o = oscs.at(-1)
    return { gain: { setValueAtTime: (v: number) => { if (o && o.peak === 0) o.peak = v }, exponentialRampToValueAtTime: (v: number) => { if (o && v > o.peak) o.peak = v } }, connect: (d: unknown) => d }
  }
  createOscillator() {
    const o: Osc = { type: '', f0: 0, start: -1, peak: 0 }
    oscs.push(o)
    return {
      set type(v: string) { o.type = v },
      frequency: { setValueAtTime: (f: number) => { if (!o.f0) o.f0 = f }, exponentialRampToValueAtTime: () => {} },
      connect: (d: unknown) => d,
      start: (t: number) => { o.start = t },
      stop: () => {},
    }
  }
}
class FakeAudio {
  paused = true; volume = 1; muted = false; currentTime = 0; preload = ''
  constructor(public src: string) {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}
beforeEach(() => {
  oscs = []
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

/** A live state with the puck mid-table, moving. */
function live(): PuckState {
  const s = blankState()
  s.phase = 1
  s.px = 0.5; s.py = 1; s.pvx = 0; s.pvy = 0
  s.m[0].x = 0.5; s.m[0].y = 0.3
  s.m[1].x = 0.5; s.m[1].y = 1.7
  return s
}
const names = (r: CueReq[]): string[] => r.map((c) => c.cue)

describe('cuesForTick: every event maps to a cue', () => {
  test('a quiet tick makes no sound', () => {
    const s = live(); s.pvx = 0.3; s.pvy = 0.4
    expect(cuesForTick(snapOf(s), s, 0)).toEqual([])
  })

  test('a mallet hit: the puck changes speed next to a mallet', () => {
    const p = live(); p.px = 0.5; p.py = 0.3 + MALLET_R + PUCK_R + 0.01
    const s = live(); s.px = p.px; s.py = p.py; s.pvy = 2
    const r = cuesForTick(snapOf(p), s, 0)
    expect(names(r)).toEqual(['hit'])
  })

  test('a wall bounce: the sideways speed flips next to a side wall', () => {
    const p = live(); p.px = PUCK_R + 0.005; p.pvx = -1.5
    const s = live(); s.px = PUCK_R + 0.005; s.pvx = 1.35
    expect(names(cuesForTick(snapOf(p), s, 0))).toEqual(['wall'])
  })

  test('a post event is the post ping, and the bounce it causes is not a second sound', () => {
    const p = live(); p.px = 0.33; p.py = 0.04; p.pvy = -1; p.pvx = 0.2
    const s = live(); s.px = 0.33; s.py = 0.04; s.pvy = 1; s.pvx = 0.2; s.ev = 1 << PUCK_EVENTS.post
    expect(names(cuesForTick(snapOf(p), s, 0))).toEqual(['post'])
  })

  test('a goal for you and a goal for them are different cues; both fire once', () => {
    const p = live()
    const mine = live(); mine.score = [1, 0]; mine.ev = 1 << PUCK_EVENTS.goal
    const theirs = live(); theirs.score = [0, 1]; theirs.ev = 1 << PUCK_EVENTS.goal
    expect(names(cuesForTick(snapOf(p), mine, 0))).toEqual(['goalYou'])
    expect(names(cuesForTick(snapOf(p), theirs, 0))).toEqual(['goalThem'])
    // seat-relative: if the human sat in seat 1 the same score is a goal against them
    expect(names(cuesForTick(snapOf(p), mine, 1))).toEqual(['goalThem'])
  })

  test('a goal that leaves a side one short of the win adds the match point cue, after the goal', () => {
    const p = live(); p.score = [GOALS_TO_WIN - 2, 2]
    const s = live(); s.score = [GOALS_TO_WIN - 1, 2]; s.ev = 1 << PUCK_EVENTS.goal
    const r = cuesForTick(snapOf(p), s, 0)
    expect(names(r)).toEqual(['goalYou', 'matchPoint'])
    expect(r[1]!.delayMs).toBeGreaterThan(r[0]!.delayMs)
    // an ordinary goal does not
    const q = live(); q.score = [2, 2]; const t = live(); t.score = [3, 2]; t.ev = 1 << PUCK_EVENTS.goal
    expect(names(cuesForTick(snapOf(q), t, 0))).toEqual(['goalYou'])
  })

  test('match point sounds only when the scorer reaches 6: their goal to 6 to 4 while you sit on 6 is not a second one', () => {
    const p = live(); p.score = [GOALS_TO_WIN - 1, 3]
    const s = live(); s.score = [GOALS_TO_WIN - 1, 4]; s.ev = 1 << PUCK_EVENTS.goal
    expect(names(cuesForTick(snapOf(p), s, 0))).toEqual(['goalThem'])
    // the same goal from the other seat's chair
    const p1 = live(); p1.score = [3, GOALS_TO_WIN - 1]
    const s1 = live(); s1.score = [4, GOALS_TO_WIN - 1]; s1.ev = 1 << PUCK_EVENTS.goal
    expect(names(cuesForTick(snapOf(p1), s1, 1))).toEqual(['goalThem'])
    // their goal that reaches 6 is match point against you, and 6 to 6 (next goal wins) pulses too
    const q = live(); q.score = [2, GOALS_TO_WIN - 2]; const r = live(); r.score = [2, GOALS_TO_WIN - 1]; r.ev = 1 << PUCK_EVENTS.goal
    expect(names(cuesForTick(snapOf(q), r, 0))).toEqual(['goalThem', 'matchPoint'])
    const a = live(); a.score = [GOALS_TO_WIN - 1, GOALS_TO_WIN - 2]; const b = live(); b.score = [GOALS_TO_WIN - 1, GOALS_TO_WIN - 1]; b.ev = 1 << PUCK_EVENTS.goal
    expect(names(cuesForTick(snapOf(a), b, 0))).toEqual(['goalThem', 'matchPoint'])
  })

  test('the final goal does not add match point (the stinger takes over)', () => {
    const p = live(); p.score = [GOALS_TO_WIN - 1, 2]
    const s = live(); s.score = [GOALS_TO_WIN, 2]; s.ev = 1 << PUCK_EVENTS.goal
    expect(names(cuesForTick(snapOf(p), s, 0))).toEqual(['goalYou'])
  })

  test('sudden death starting is the tension cue', () => {
    const p = live(); const s = live(); s.sudden = 1
    expect(names(cuesForTick(snapOf(p), s, 0))).toEqual(['matchPoint'])
  })

  test('the serve is a soft tick', () => {
    const p = live(); p.phase = 0
    const s = live(); s.phase = 1
    expect(names(cuesForTick(snapOf(p), s, 0))).toEqual(['serve'])
  })

  test('at most one cue per kind per tick, however many things happened', () => {
    const p = live(); p.px = 0.005 + PUCK_R; p.py = 0.3 + MALLET_R + PUCK_R + 0.01; p.pvx = -2
    const s = live(); s.px = p.px; s.py = p.py; s.pvx = 2; s.pvy = 2
    const r = names(cuesForTick(snapOf(p), s, 0))
    expect(new Set(r).size).toBe(r.length)
  })
})

describe('volume scales with hit speed', () => {
  test('harder is louder, bounded, and never silent', () => {
    expect(hitGain(0.2)).toBeLessThan(hitGain(1.5))
    expect(hitGain(1.5)).toBeLessThan(hitGain(PUCK_MAX_SPEED))
    expect(hitGain(100)).toBe(hitGain(PUCK_MAX_SPEED * 2))
    expect(hitGain(0.2)).toBeGreaterThan(0.05)
    expect(hitGain(100)).toBeLessThanOrEqual(1)
  })

  test('a harder hit starts the oscillator louder', () => {
    playPuckCue({ cue: 'hit', gain: hitGain(0.5), delayMs: 0 }, 0)
    const soft = Math.max(...oscs.map((o) => o.peak))
    oscs = []; resetVoicesForTests()
    playPuckCue({ cue: 'hit', gain: hitGain(4), delayMs: 0 }, 10_000)
    const hard = Math.max(...oscs.map((o) => o.peak))
    expect(hard).toBeGreaterThan(soft)
    expect(hard).toBeLessThanOrEqual(PEAK.hit)
  })
})

describe('audible on a phone speaker', () => {
  // Phone speakers give little below about 200 Hz, so the low cues carry a quieter partial an octave or two up. Still sine, still soft.
  const cue = (c: 'matchPoint' | 'wall') => { playPuckCue({ cue: c, gain: 1, delayMs: 0 }, 0); const o = oscs; oscs = []; resetVoicesForTests(); return o }
  test('match point has a partial at 200 Hz or more, quieter than its low note', () => {
    const o = cue('matchPoint')
    const high = o.filter((x) => x.f0 >= 200), low = o.filter((x) => x.f0 < 200)
    expect(high.length).toBeGreaterThan(0)
    expect(Math.max(...high.map((x) => x.peak))).toBeLessThan(Math.max(...low.map((x) => x.peak)))
    expect(o.every((x) => x.type === 'sine')).toBe(true)
  })
  test('the rail knock has a partial at 400 Hz or more, quieter than its low note', () => {
    const o = cue('wall')
    const high = o.filter((x) => x.f0 >= 400), low = o.filter((x) => x.f0 < 400)
    expect(high.length).toBeGreaterThan(0)
    expect(Math.max(...high.map((x) => x.peak))).toBeLessThan(Math.max(...low.map((x) => x.peak)))
    expect(o.every((x) => x.type === 'sine')).toBe(true)
  })
})

describe('settings and limits', () => {
  test('muted is silent; the master volume scales the cue', () => {
    setMuted(true)
    playPuckCue({ cue: 'post', gain: 1, delayMs: 0 }, 0)
    expect(oscs.length).toBe(0)
    setMuted(false)
    setVolume(0.5)
    playPuckCue({ cue: 'post', gain: 1, delayMs: 0 }, 1000)
    const half = Math.max(...oscs.map((o) => o.peak))
    oscs = []; resetVoicesForTests(); setVolume(1)
    playPuckCue({ cue: 'post', gain: 1, delayMs: 0 }, 5000)
    expect(Math.max(...oscs.map((o) => o.peak))).toBeGreaterThan(half)
  })

  test('no Web Audio: nothing throws', () => {
    g.window = {}
    resetAudioForTests()
    expect(() => playPuckCue({ cue: 'hit', gain: 1, delayMs: 0 }, 0)).not.toThrow()
  })

  test('sixty hits a second do not make sixty sounds', () => {
    for (let i = 0; i < 60; i++) playPuckCue({ cue: 'hit', gain: 1, delayMs: 0 }, i * (1000 / 60))
    const starts = new Set(oscs.map((o) => o.start)).size
    expect(starts).toBeLessThanOrEqual(Math.ceil(1000 / HIT_GAP_MS))
    expect(oscs.length).toBeLessThanOrEqual(60)
    expect(oscs.length).toBeGreaterThan(0)
  })

  test('voices sounding at once are capped', () => {
    const kinds = ['hit', 'wall', 'post', 'goalYou', 'goalThem', 'matchPoint', 'serve'] as const
    let t = 0
    for (let i = 0; i < 40; i++) { playPuckCue({ cue: kinds[i % kinds.length]!, gain: 1, delayMs: 0 }, t); t += 400 / 40 }
    expect(oscs.length).toBeLessThanOrEqual(MAX_VOICES + 20) // started over time, but never more than MAX_VOICES live
    resetVoicesForTests(); oscs = []
    for (const k of kinds) playPuckCue({ cue: k, gain: 1, delayMs: 0 }, 100_000 + kinds.indexOf(k) * 1000 * 0)
    expect(oscs.length).toBeLessThanOrEqual(MAX_VOICES)
  })
})

describe('result stingers and the music mood', () => {
  test('the match music is the action mood', () => {
    expect(moodForGame('puck')).toBe('action')
  })

  test('win and loss use the shared stingers; a draw plays none; mute silences the stinger', () => {
    playResult(0, 0, 0)
    playResult(1, 0, 0)
    playResult(-1, 0, 0)
    const stingers = (): Array<{ outcome?: string; played?: boolean }> =>
      (g.window as { __duelwiseAudio?: { events: Array<{ type: string; outcome?: string; played?: boolean }> } }).__duelwiseAudio!.events.filter((e) => e.type === 'stinger')
    expect(stingers().map((e) => e.outcome)).toEqual(['win', 'loss'])
    expect(stingers().every((e) => e.played)).toBe(true)
    setMuted(true)
    playResult(0, 0, 0)
    expect(stingers().at(-1)!.played).toBe(false)
  })
})
