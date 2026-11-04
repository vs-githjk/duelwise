import type { Kick } from '@duelwise/core/src/games/penalty/core'
import type { Result, Seat } from '@duelwise/core/src/types'
import { getVolume, isMuted, resumeAudioContext, sharedAudioContext, subscribeAudio } from '../../lib/audio'
import { playStinger } from '../../lib/music'

// Twelve Yards sound. The ball cues (strike, net, glove, wide) are synthesised on the page's shared AudioContext. The crowd and the referee's whistle are
// short CC0 recordings (public/assets/audio/opengameart/crowd, credited in its CREDITS.md), loaded lazily after the first tap and played through the same
// cue bus, so the sound switch and the master volume apply the way they do for Stormglass and Crosscurrent. A file that has not loaded yet, or fails to,
// falls back to a synthesised version of the same cue (noise through vowel-like filters for the crowd, a trilled pea whistle), so a cue is never missing.
// Win and loss are the shared result stingers, which also duck the action loop under them.
//
//   strike   the boot on the ball: a low thump and a slap of leather
//   net      the ball in the net: a swish and a short rustle of at most NET_TICKS bursts
//   glove    the keeper's hands on the ball: a dull, heavy knock
//   wide     the ball past the goal: a thin whoosh
//   whistle  start of the shootout (one blast) and full time (two short, one long)
//   cheer    the crowd for your goal; cheerSave for your save; cheerBig for winning the shootout
//   groan    the crowd when your kick does not go in; groanBig when you lose
//
// There is no crowd murmur under play: the action loop already carries the match, and a second bed would fight it (and with the music switched off the
// match is meant to be quiet). Levels are matched to Stormglass: its fire shot peaks at about 0.53 of full scale, so the thump sits there, the crowd under it.

export type PenaltyCue = 'strike' | 'net' | 'glove' | 'wide' | 'whistleStart' | 'whistleFull' | 'cheer' | 'cheerSave' | 'cheerBig' | 'groan' | 'groanBig'

/** Peak gain before the master volume. */
export const PEAK = { strike: 0.5, net: 0.16, glove: 0.4, wide: 0.1, whistle: 0.2, cheer: 0.3, cheerSave: 0.17, cheerBig: 0.42, groan: 0.22, groanBig: 0.26 } as const

/** Bursts in one net rustle, however hard the ball hit. */
export const NET_TICKS = 3
/** Sources (oscillators and noise) sounding or scheduled at once, across every cue. The full-time synth whistle is nine (three blasts of two tones and a flutter), a cheer is one, the net two. */
export const MAX_VOICES = 12
/** From the closing kick's reveal to the result panel. With reduced motion nothing is held for show, so a short beat is enough. */
export const END_HOLD_MS = 1080
export const END_HOLD_REDUCED_MS = 400
/** The crowd comes in this long after the full-time whistle begins. */
export const END_CROWD_DELAY_MS = 220

export const endHoldMs = (reducedMotion: boolean): number => (reducedMotion ? END_HOLD_REDUCED_MS : END_HOLD_MS)

export interface TimedCue {
  cue: PenaltyCue
  delayMs: number
}

/**
 * What the ball arriving sounds like, from the kick as played. The crowd answers the player's own kick (a goal cheers, a save or a miss groans) and the
 * player's own save; the opponent's goal is only the net. When this kick decides the shootout the crowd's answer is the end cue instead, so it is not doubled.
 */
export function cuesForKick(k: Kick, human: Seat, opts: { terminal?: boolean; reducedMotion?: boolean } = {}): TimedCue[] {
  const mine = k.kicker === human
  const out: TimedCue[] = []
  if (k.goal) {
    out.push({ cue: 'net', delayMs: 0 })
    if (mine && !opts.terminal) out.push({ cue: 'cheer', delayMs: 160 })
  } else if (k.onTarget) {
    out.push({ cue: 'glove', delayMs: 0 })
    if (!opts.terminal) out.push(mine ? { cue: 'groan', delayMs: 200 } : { cue: 'cheerSave', delayMs: 160 })
  } else {
    out.push({ cue: 'wide', delayMs: 0 })
    if (mine && !opts.terminal) out.push({ cue: 'groan', delayMs: 240 })
  }
  return out
}

/** Full time: the whistle, then the crowd for how it ended. A draw, which only sudden death's end can leave, is the whistle alone. */
export function cuesForEnd(result: Result, human: Seat): TimedCue[] {
  const out: TimedCue[] = [{ cue: 'whistleFull', delayMs: 0 }]
  if (result.winner === human) out.push({ cue: 'cheerBig', delayMs: END_CROWD_DELAY_MS })
  else if (result.winner !== null) out.push({ cue: 'groanBig', delayMs: END_CROWD_DELAY_MS })
  return out
}

// ---- recorded cues ------------------------------------------------------------------------------------------------

const CROWD_ROOT = '/assets/audio/opengameart/crowd'
/** The cues that are recordings. Every file is mono 44.1 kHz MP3 with its own fades, levelled so the loudest sample sits at the dBFS in FILE_PEAK_DB. */
export const CUE_FILES: Partial<Record<PenaltyCue, string>> = {
  whistleStart: `${CROWD_ROOT}/whistleStart.mp3`,
  whistleFull: `${CROWD_ROOT}/whistleFull.mp3`,
  cheer: `${CROWD_ROOT}/cheer.mp3`,
  cheerSave: `${CROWD_ROOT}/cheerSave.mp3`,
  cheerBig: `${CROWD_ROOT}/cheerBig.mp3`,
  groan: `${CROWD_ROOT}/groan.mp3`,
  groanBig: `${CROWD_ROOT}/groanBig.mp3`,
}
/** Gain applied to each recording before the master volume, so its peak lands where the synth's did (all under the boot's 0.5). */
export const FILE_GAIN: Record<string, number> = { whistleStart: 0.55, whistleFull: 0.55, cheer: 0.62, cheerSave: 0.7, cheerBig: 0.7, groan: 0.62, groanBig: 0.62 }

/** Decoded recordings by cue, per context. 'failed' means the fetch or decode failed, so the synth plays that cue. */
const decoded = new WeakMap<object, Map<PenaltyCue, AudioBuffer | 'failed'>>()
const loading = new WeakSet<object>()

/** The decoded recordings the context has so far (empty before the first preload). */
function filesFor(ctx: BaseAudioContext): Map<PenaltyCue, AudioBuffer | 'failed'> {
  let m = decoded.get(ctx)
  if (!m) {
    m = new Map()
    decoded.set(ctx, m)
  }
  return m
}

/**
 * Fetches and decodes the recordings, once per context. Call it after the player's first tap; it never blocks and never throws: a file that does
 * not arrive is marked failed and that cue keeps its synthesised sound. Does nothing while sound is off.
 */
export function preloadCueFiles(): void {
  try {
    if (isMuted() || typeof fetch !== 'function') return
    const ctx = sharedAudioContext()
    if (!ctx || typeof ctx.decodeAudioData !== 'function' || loading.has(ctx)) return
    loading.add(ctx)
    const have = filesFor(ctx)
    for (const [cue, url] of Object.entries(CUE_FILES) as Array<[PenaltyCue, string]>) {
      void (async () => {
        try {
          const res = await fetch(url)
          if (!res.ok) throw new Error(String(res.status))
          have.set(cue, await ctx.decodeAudioData(await res.arrayBuffer()))
        } catch {
          have.set(cue, 'failed')
        }
      })()
    }
  } catch {
    // never let a sound break a game
  }
}

// ---- voices -------------------------------------------------------------------------------------------------------

/** Wall-clock end of every source started or scheduled and not yet finished. */
let live: number[] = []

export function resetVoicesForTests(): void {
  live = []
  bus = null
}

// Every cue plays through one gain node of its own, so a sound that is still ringing can be cut: when the sound switch goes off, when a new match starts and when the page goes.
let bus: { ctx: BaseAudioContext; node: GainNode } | null = null
let watching = false

function busFor(ctx: AudioContext): GainNode {
  if (!bus || bus.ctx !== ctx) {
    const node = ctx.createGain()
    node.connect(ctx.destination)
    bus = { ctx, node }
  }
  return bus.node
}

/** Whether anything is routed through the cue bus (a test hook). */
export const busActive = (): boolean => bus !== null

/** Cuts every cue that is sounding or scheduled: a cheer is not left ringing into the rematch, the next page or a muted page. */
export function silenceAll(): void {
  const b = bus
  bus = null
  live = []
  if (!b) return
  try {
    b.node.gain.cancelScheduledValues(0)
  } catch {
    // no scheduler to cancel
  }
  try {
    b.node.gain.value = 0
    b.node.disconnect()
  } catch {
    // already gone
  }
}

/** Reserves n sources for a cue of this length; false (nothing reserved) when that would pass MAX_VOICES. */
function claim(n: number, delayMs: number, lenSec: number): boolean {
  const now = Date.now()
  live = live.filter((end) => end > now)
  if (live.length + n > MAX_VOICES) return false
  for (let i = 0; i < n; i++) live.push(now + delayMs + lenSec * 1000)
  return true
}

const noises = new WeakMap<object, AudioBuffer>()

/** Three seconds of pink-ish noise, made once per context. */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const have = noises.get(ctx)
  if (have) return have
  const len = Math.floor(ctx.sampleRate * 3)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  // A fixed sequence, so a cue sounds the same each time and a render is repeatable.
  let seed = 0x2f6e2b1
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < len; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    const w = (seed >>> 8) / 8388608 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
  }
  noises.set(ctx, buf)
  return buf
}

function noiseSource(ctx: BaseAudioContext, t0: number, len: number, offset: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx)
  src.start(t0, offset, len + 0.05)
  return src
}

/** A gain that rises to `peak` over `attack`, holds the shape through `points` (time after start, level 0..1 of peak) and is silent by `len`. */
function shape(g: GainNode, t0: number, peak: number, attack: number, len: number, points: Array<[number, number]> = []): void {
  const p = g.gain
  p.setValueAtTime(0.0001, t0)
  p.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack)
  for (const [at, level] of points) p.exponentialRampToValueAtTime(Math.max(peak * level, 0.0002), t0 + at)
  p.exponentialRampToValueAtTime(0.0001, t0 + len)
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  return f
}

function tone(ctx: BaseAudioContext, out: AudioNode, t0: number, type: OscillatorType, from: number, to: number, len: number, attack: number, peak: number): void {
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(from, t0)
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + len * 0.8)
  shape(amp, t0, peak, attack, len)
  osc.connect(amp)
  amp.connect(out)
  osc.start(t0)
  osc.stop(t0 + len + 0.02)
}

/** One vowel-like crowd: noise through formant filters whose centres glide, under a swelling gain. The filters take most of the noise's energy, so `makeup` brings the result up to where it is measured (rendered offline in Chromium at volume 0.7: strike peak 0.29, goal cheer rms 0.034 and peak 0.35, winning cheer rms 0.074 and peak 0.46, no cue above 0.5 and nothing clipping). */
function crowd(ctx: BaseAudioContext, out: AudioNode, t0: number, o: { len: number; attack: number; peak: number; formants: Array<[number, number, number, number]>; points?: Array<[number, number]>; offset: number; makeup: number }): void {
  const src = noiseSource(ctx, t0, o.len, o.offset)
  const amp = ctx.createGain()
  shape(amp, t0, o.peak, o.attack, o.len, o.points)
  // formant: [from Hz, to Hz, Q, weight]
  for (const [from, to, q, weight] of o.formants) {
    const f = biquad(ctx, 'bandpass', from, q)
    f.frequency.setValueAtTime(from, t0)
    f.frequency.exponentialRampToValueAtTime(to, t0 + o.len * 0.85)
    const w = ctx.createGain()
    w.gain.value = weight * o.makeup
    src.connect(f)
    f.connect(w)
    w.connect(amp)
  }
  amp.connect(out)
  src.stop(t0 + o.len + 0.05)
}

/** The sources a cue starts, so the cap can reserve them first. */
const SOURCES: Record<PenaltyCue, number> = { strike: 2, net: 2, glove: 2, wide: 1, whistleStart: 3, whistleFull: 9, cheer: 1, cheerSave: 1, cheerBig: 1, groan: 1, groanBig: 1 }
/** How long a cue sounds, in seconds, for the same reservation. */
const LENGTH: Record<PenaltyCue, number> = { strike: 0.12, net: 0.5, glove: 0.2, wide: 0.35, whistleStart: 0.4, whistleFull: 1.2, cheer: 2.2, cheerSave: 1.3, cheerBig: 3.6, groan: 1.5, groanBig: 2.1 }

/** Plays a decoded recording through the cue bus at the cue's file gain. */
function playFile(ctx: BaseAudioContext, out: AudioNode, cue: PenaltyCue, buf: AudioBuffer, t0: number, vol: number): void {
  const src = ctx.createBufferSource()
  src.buffer = buf
  const g = ctx.createGain()
  g.gain.value = (FILE_GAIN[cue] ?? 0.5) * vol
  src.connect(g)
  g.connect(out)
  src.start(t0)
}

/**
 * Builds one cue on any audio context: the live one, or an offline one to measure it. `vol` is the master volume. A cue with a decoded recording in `files`
 * plays that; otherwise it is synthesised.
 */
export function scheduleCue(ctx: BaseAudioContext, out: AudioNode, cue: PenaltyCue, t0: number, vol: number, reducedMotion = false, files?: Map<PenaltyCue, AudioBuffer | 'failed'>): void {
  const v = (n: number) => n * vol
  const rec = files?.get(cue)
  if (rec && rec !== 'failed') {
    playFile(ctx, out, cue, rec, t0, vol)
    return
  }
  switch (cue) {
    case 'strike': {
      tone(ctx, out, t0, 'sine', 165, 52, 0.11, 0.004, v(PEAK.strike))
      const s = noiseSource(ctx, t0, 0.06, 0.2)
      const f = biquad(ctx, 'lowpass', 1100, 0.7)
      const a = ctx.createGain()
      shape(a, t0, v(PEAK.strike * 0.7), 0.003, 0.06)
      s.connect(f)
      f.connect(a)
      a.connect(out)
      s.stop(t0 + 0.08)
      return
    }
    case 'net': {
      // The swish of the ball into the cords, then the netting settling in at most NET_TICKS rustles.
      const s = noiseSource(ctx, t0, 0.5, 0.9)
      const f = biquad(ctx, 'bandpass', 2600, 1.1)
      f.frequency.setValueAtTime(2600, t0)
      f.frequency.exponentialRampToValueAtTime(1100, t0 + 0.4)
      const a = ctx.createGain()
      const ticks = reducedMotion ? 1 : NET_TICKS
      a.gain.setValueAtTime(0.0001, t0)
      a.gain.exponentialRampToValueAtTime(v(PEAK.net) * 1.8, t0 + 0.012)
      a.gain.exponentialRampToValueAtTime(v(PEAK.net) * 0.45, t0 + 0.14)
      for (let i = 0; i < ticks - 1; i++) {
        const at = 0.14 + i * 0.1
        a.gain.exponentialRampToValueAtTime(v(PEAK.net) * (0.45 - i * 0.12), t0 + at + 0.025)
        a.gain.exponentialRampToValueAtTime(v(PEAK.net) * 0.1, t0 + at + 0.09)
      }
      a.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5)
      s.connect(f)
      f.connect(a)
      a.connect(out)
      s.stop(t0 + 0.52)
      tone(ctx, out, t0, 'sine', 330, 190, 0.2, 0.01, v(PEAK.net * 0.5))
      return
    }
    case 'glove': {
      const s = noiseSource(ctx, t0, 0.14, 1.4)
      const f = biquad(ctx, 'lowpass', 520, 0.8)
      const a = ctx.createGain()
      shape(a, t0, v(PEAK.glove), 0.004, 0.14)
      s.connect(f)
      f.connect(a)
      a.connect(out)
      s.stop(t0 + 0.16)
      tone(ctx, out, t0, 'sine', 125, 62, 0.16, 0.004, v(PEAK.glove * 0.8))
      return
    }
    case 'wide': {
      const s = noiseSource(ctx, t0, 0.32, 2.1)
      const f = biquad(ctx, 'bandpass', 1900, 0.9)
      f.frequency.setValueAtTime(1900, t0)
      f.frequency.exponentialRampToValueAtTime(650, t0 + 0.3)
      const a = ctx.createGain()
      shape(a, t0, v(PEAK.wide) * 2.5, 0.04, 0.32)
      s.connect(f)
      f.connect(a)
      a.connect(out)
      s.stop(t0 + 0.34)
      return
    }
    case 'whistleStart':
    case 'whistleFull': {
      // A pea whistle: two close tones near 3 kHz that beat against each other, a quick pitch warble and a fast flutter in loudness, in short blasts.
      const blasts: Array<[number, number]> = cue === 'whistleStart' ? [[0, 0.4]] : [[0, 0.17], [0.3, 0.17], [0.62, 0.42]]
      for (const [at, len] of blasts) {
        const lfo = ctx.createOscillator()
        lfo.frequency.value = 29
        const flutter = ctx.createGain()
        flutter.gain.value = 0.35
        const warble = ctx.createGain()
        warble.gain.value = 70
        const trem = ctx.createGain()
        trem.gain.value = 0.65
        lfo.connect(flutter)
        flutter.connect(trem.gain)
        lfo.connect(warble)
        const env = ctx.createGain()
        shape(env, t0 + at, v(PEAK.whistle), 0.015, len)
        trem.connect(env)
        env.connect(out)
        for (const hz of [2960, 3170]) {
          const osc = ctx.createOscillator()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(hz, t0 + at)
          warble.connect(osc.frequency)
          osc.connect(trem)
          osc.start(t0 + at)
          osc.stop(t0 + at + len + 0.02)
        }
        lfo.start(t0 + at)
        lfo.stop(t0 + at + len + 0.02)
      }
      return
    }
    case 'cheer':
      // A swell of "aah" with a lift in the middle.
      crowd(ctx, out, t0, { len: 1.6, attack: 0.3, peak: v(PEAK.cheer), offset: 0.3, makeup: 4, points: [[0.7, 0.8]], formants: [[620, 760, 2.2, 1], [1150, 1350, 3, 0.8], [2500, 2800, 1.6, 0.4]] })
      return
    case 'cheerSave':
      crowd(ctx, out, t0, { len: 0.9, attack: 0.16, peak: v(PEAK.cheerSave), offset: 1.1, makeup: 8, formants: [[640, 720, 2.2, 1], [1200, 1300, 3, 0.7]] })
      return
    case 'cheerBig':
      // The whole ground: a first roar, a second wave on top of it, and a long tail.
      crowd(ctx, out, t0, { len: 3, attack: 0.35, peak: v(PEAK.cheerBig), offset: 0, makeup: 2.6, points: [[0.9, 0.85], [1.3, 1], [2, 0.6]], formants: [[560, 820, 2, 1], [1100, 1500, 2.6, 0.9], [2300, 3000, 1.4, 0.55], [330, 360, 1.5, 0.5]] })
      return
    case 'groan':
      // A falling "ooh".
      crowd(ctx, out, t0, { len: 1.3, attack: 0.22, peak: v(PEAK.groan), offset: 1.7, makeup: 6, formants: [[520, 330, 3, 1], [980, 620, 3.2, 0.55]] })
      return
    case 'groanBig':
      crowd(ctx, out, t0, { len: 1.8, attack: 0.3, peak: v(PEAK.groanBig), offset: 0.6, makeup: 5, points: [[0.8, 0.9]], formants: [[480, 280, 3, 1], [900, 520, 3.2, 0.6], [300, 220, 2, 0.4]] })
      return
  }
}

/** Test hook: the cues that were actually scheduled, in order (window.__duelwisePenaltySounds), so a spec can tell what a match sounded like without listening. Capped. */
function heard(cue: PenaltyCue): void {
  try {
    const w = window as unknown as { __duelwisePenaltySounds?: string[] }
    const list = (w.__duelwisePenaltySounds ??= [])
    list.push(cue)
    if (list.length > 200) list.shift()
  } catch {
    // no window
  }
}

/** Plays one cue through the shared AudioContext, so mute and volume apply. Silent where Web Audio is missing; never throws. */
export function playCue(cue: PenaltyCue, delayMs = 0, reducedMotion = false): void {
  try {
    if (isMuted()) return
    const ctx = sharedAudioContext()
    if (!ctx) return
    const rec = filesFor(ctx).get(cue)
    if (!claim(rec && rec !== 'failed' ? 1 : SOURCES[cue], delayMs, LENGTH[cue])) return
    heard(cue)
    if (!watching) {
      watching = true
      subscribeAudio(() => {
        if (isMuted()) silenceAll()
      })
    }
    resumeAudioContext()
    preloadCueFiles()
    scheduleCue(ctx, busFor(ctx), cue, ctx.currentTime + delayMs / 1000, getVolume(), reducedMotion, filesFor(ctx))
  } catch {
    // never let a sound break a game
  }
}

export function playTimed(cues: TimedCue[], reducedMotion = false): void {
  for (const c of cues) playCue(c.cue, c.delayMs, reducedMotion)
}

/** The result panel's stinger: the shared win or loss jingle, which ducks the loop. A draw has none. */
export function playResultStinger(result: Result, human: Seat): void {
  if (result.winner === null) return
  playStinger(result.winner === human ? 'win' : 'loss')
}
