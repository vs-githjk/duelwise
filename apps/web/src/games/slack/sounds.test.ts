import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetAudioForTests, setMuted, setVolume } from '../../lib/audio'
import { moodForGame, resetMusicForTests } from '../../lib/music'
import { FLIP_MID_MS, FLIP_STAGGER_MS, MAX_TICKS, MAX_VOICES, PEAK, playCue, playMove, resetVoicesForTests, soundsForMove, type MoveSound } from './sounds'
import { applyMove, startMatch } from './match'

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

/** The move a seat makes from the opening position, as the page would hand it over. */
function openingMove(seat: 0 | 1, code: number): { seat: 0 | 1; cell: number; flips: number[] } {
  let m = startMatch()
  if (seat === 1) m = applyMove(m, 0, 19)
  const next = applyMove(m, seat, code)
  return { seat, cell: next.last!.cell!, flips: next.last!.flips }
}

describe('what a move sounds like', () => {
  test('your disc and the reply are different cues, and the reply is not a copy of yours', () => {
    const mine = soundsForMove(openingMove(0, 19), 0, false)
    const reply = soundsForMove(openingMove(1, 18), 0, false)
    expect(mine[0]!.cue).toBe('place')
    expect(reply[0]!.cue).toBe('reply')
    expect(mine.some((s) => s.cue === 'reply')).toBe(false)
  })

  test('a flip is a ripple of ticks timed to the 30 ms per-disc cascade, never more than the cap', () => {
    // Placing on the edge of a long line flips discs at several distances: ticks land at the midpoint of each ring turning over.
    const flips = [27, 28, 29, 30, 31] // one row, distances 1 to 5 from cell 26
    const ticks = soundsForMove({ seat: 0, cell: 26, flips }, 0, false).filter((s) => s.cue === 'flip')
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS)
    expect(ticks.length).toBeGreaterThan(1)
    for (const t of ticks) {
      const ring = (t.delayMs - FLIP_MID_MS) / FLIP_STAGGER_MS
      expect(Number.isInteger(ring) && ring >= 0 && ring <= 4).toBe(true)
    }
    const delays = ticks.map((t) => t.delayMs)
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
    const steps = ticks.map((t) => t.step ?? 0)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    expect(new Set(steps).size).toBe(steps.length)
  })

  test('a huge flip is still at most MAX_TICKS ticks, and one disc is one tick', () => {
    const many = Array.from({ length: 22 }, (_, i) => 8 + i)
    expect(soundsForMove({ seat: 0, cell: 0, flips: many }, 0, false).filter((s) => s.cue === 'flip').length).toBeLessThanOrEqual(MAX_TICKS)
    expect(soundsForMove({ seat: 0, cell: 26, flips: [27] }, 0, false).filter((s) => s.cue === 'flip')).toHaveLength(1)
  })

  test('a corner adds a small extra, for either side; a middle cell does not', () => {
    for (const cell of [0, 7, 56, 63]) {
      expect(soundsForMove({ seat: 0, cell, flips: [] }, 0, false).some((s) => s.cue === 'corner')).toBe(true)
      expect(soundsForMove({ seat: 1, cell, flips: [] }, 0, false).some((s) => s.cue === 'corner')).toBe(true)
    }
    expect(soundsForMove({ seat: 0, cell: 27, flips: [] }, 0, false).some((s) => s.cue === 'corner')).toBe(false)
  })

  test('a pass is its own cue and places no disc', () => {
    const s = soundsForMove({ seat: 1, cell: null, flips: [] }, 0, false)
    expect(s.map((x) => x.cue)).toEqual(['pass'])
  })

  test('reduced motion: nothing is timed to a cascade that does not run, and the ripple is a single tick', () => {
    const flips = [27, 28, 29, 30, 31]
    const s = soundsForMove({ seat: 0, cell: 26, flips }, 0, true)
    const ticks = s.filter((x): x is MoveSound => x.cue === 'flip')
    expect(ticks).toHaveLength(1)
    expect(ticks[0]!.delayMs).toBeLessThanOrEqual(FLIP_MID_MS)
  })

  test('a move that flips nothing makes no flip tick', () => {
    expect(soundsForMove({ seat: 0, cell: 27, flips: [] }, 0, false).some((s) => s.cue === 'flip')).toBe(false)
  })
})

describe('how it plays', () => {
  test('each cue is a real tone through the shared context, scheduled at its delay', () => {
    playCue('place')
    playCue('reply')
    expect(oscs.length).toBeGreaterThanOrEqual(2)
    playCue('flip', 100)
    const tick = oscs.at(-1)!
    expect(tick.start).toBeCloseTo(10.1, 6)
  })

  test('your disc and the reply differ in pitch and tone', () => {
    playCue('place')
    const a = oscs[0]!
    oscs = []
    resetVoicesForTests()
    playCue('reply')
    const b = oscs[0]!
    expect(a.f0).not.toBe(b.f0)
    expect(b.f0).toBeLessThan(a.f0)
    expect(a.type).not.toBe(b.type)
  })

  test('levels sit with Stormglass: the disc cues peak near its fire shot (0.53), ticks stay under them', () => {
    expect(PEAK.place).toBeGreaterThanOrEqual(0.4)
    expect(PEAK.place).toBeLessThanOrEqual(0.6)
    expect(PEAK.reply).toBeGreaterThanOrEqual(0.35)
    expect(PEAK.reply).toBeLessThanOrEqual(PEAK.place)
    expect(PEAK.flip).toBeLessThan(PEAK.reply)
    for (const k of Object.keys(PEAK) as Array<keyof typeof PEAK>) expect(PEAK[k]).toBeLessThanOrEqual(0.6)
  })

  test('the master volume scales every cue and the sound switch silences them', () => {
    setVolume(0.5)
    playCue('place')
    const loud = Math.max(...oscs.map((o) => o.peak))
    oscs = []
    resetVoicesForTests()
    setVolume(0.25)
    playCue('place')
    expect(Math.max(...oscs.map((o) => o.peak))).toBeCloseTo(loud / 2, 6)
    oscs = []
    resetVoicesForTests()
    setMuted(true)
    for (const c of ['place', 'reply', 'flip', 'pass', 'corner', 'draw'] as const) playCue(c)
    playMove({ seat: 0, cell: 0, flips: [1, 2, 3] }, 0)
    expect(oscs).toHaveLength(0)
  })

  test('a burst never holds more than MAX_VOICES at once', () => {
    for (let i = 0; i < 40; i++) playCue('flip')
    expect(oscs.length).toBeLessThanOrEqual(MAX_VOICES)
    expect(oscs.length).toBeGreaterThan(0)
  })

  test('one whole move (disc, corner, ripple) fits the cap, so a reply right after still sounds', () => {
    playMove({ seat: 0, cell: 0, flips: Array.from({ length: 12 }, (_, i) => 1 + i) }, 0)
    expect(oscs.length).toBeLessThanOrEqual(MAX_VOICES)
    expect(oscs.some((o) => o.f0 > 0)).toBe(true)
  })

  test('every cue is safe with no audio device', () => {
    g.window = {}
    resetAudioForTests()
    resetVoicesForTests()
    for (const c of ['place', 'reply', 'flip', 'pass', 'corner', 'win', 'lose', 'draw'] as const) expect(() => playCue(c)).not.toThrow()
    expect(() => playMove({ seat: 1, cell: 63, flips: [62] }, 0)).not.toThrow()
  })

  test('win and loss are the shared result stingers (they duck the music); the draw is the game\'s own', () => {
    playCue('win')
    playCue('lose')
    const events = (g.window as { __duelwiseAudio?: { events: Array<{ type: string; outcome?: string }> } }).__duelwiseAudio!.events.filter((e) => e.type === 'stinger')
    expect(events.map((e) => e.outcome)).toEqual(['win', 'loss'])
    oscs = []
    playCue('draw')
    expect(oscs.length).toBeGreaterThan(0)
  })
})

test('Crosscurrent has a board music mood', () => {
  expect(moodForGame('slack')).toBe('board')
})
