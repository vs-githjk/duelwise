import { GOALS_TO_WIN, MALLET_R, PUCK_EVENTS, PUCK_MAX_SPEED, PUCK_R } from '@duelwise/core/src/games/puck/constants'
import type { PuckState } from '@duelwise/core/src/games/puck/state'
import type { Seat } from '@duelwise/core/src/types'
import { getVolume, isMuted, resumeAudioContext, sharedAudioContext } from '../../lib/audio'
import { playStinger } from '../../lib/music'

// Air hockey cues. Every one is synthesised from sine and triangle oscillators on the page's shared AudioContext: no files, so nothing
// to license, and the sound switch and master volume apply as they do for the other realtime games. Pure tones with soft attacks and no
// noise or square waves, so nothing here is harsh (Twelve Yards lesson: a hard synth sounds like an alarm). The match music is the shared
// action loop (music.ts, moodForGame('puck')); win and loss are the shared stingers, which also duck it.
//
//   hit        mallet on puck: a short wooden clack, louder and a touch higher the harder it is struck
//   wall       puck off a rail: a low soft knock
//   post       puck off a goal post: a bright two-partial ping
//   goalYou    your goal: a rising three-note chime
//   goalThem   their goal: two soft falling notes, low and brief (never a buzzer)
//   matchPoint a slow low double pulse after the goal that leaves one side a goal from winning, and when sudden death begins
//   serve      a faint tick when the puck is put in play
//
// The sim raises events for goals, posts, shots, saves, near misses and fouls, but not for the plain mallet hit or rail bounce, so those
// two are read from the puck's velocity change between ticks (cuesForTick). Nothing here touches the core or its determinism.

export type PuckCue = 'hit' | 'wall' | 'post' | 'goalYou' | 'goalThem' | 'matchPoint' | 'serve'

/** Peak gain before the master volume. A hit scales between HIT_FLOOR and PEAK.hit. */
export const PEAK = { hit: 0.5, wall: 0.3, post: 0.32, goal: 0.34, matchPoint: 0.3, serve: 0.14 } as const
const HIT_FLOOR = 0.2
/** Fewest ms between two cues of one kind; at 60 ticks a second a held-against-wall puck would otherwise chatter. */
export const HIT_GAP_MS = 45
const GAP_MS: Record<PuckCue, number> = { hit: HIT_GAP_MS, wall: 70, post: 120, goalYou: 500, goalThem: 500, matchPoint: 1500, serve: 250 }
/** Oscillators sounding or scheduled at once, across every cue (phones: keep the audio thread light). */
export const MAX_VOICES = 8
/** The tension pulse lands after the goal's own cue has mostly rung out. */
const MATCH_POINT_DELAY_MS = 700
/** Speed change (table widths a second) below which a tick is drag, not a strike. */
const MIN_STRIKE = 0.12
/** A puck this near a mallet's edge, or this near a rail, counts as touching it for a sound. */
const MALLET_REACH = MALLET_R + PUCK_R + 0.04
const RAIL_REACH = PUCK_R + 0.03

export interface CueReq {
  cue: PuckCue
  /** 0..1, relative; multiplied by the cue's peak and the master volume. */
  gain: number
  delayMs: number
}

/** What the next tick needs to remember about this one. */
export interface Snap {
  px: number
  py: number
  pvx: number
  pvy: number
  s0: number
  s1: number
  phase: number
  sudden: number
}

export function snapOf(s: PuckState, into?: Snap): Snap {
  const o = into ?? { px: 0, py: 0, pvx: 0, pvy: 0, s0: 0, s1: 0, phase: 0, sudden: 0 }
  o.px = s.px; o.py = s.py; o.pvx = s.pvx; o.pvy = s.pvy
  o.s0 = s.score[0]; o.s1 = s.score[1]; o.phase = s.phase; o.sudden = s.sudden
  return o
}

/** Gain of a strike from the puck's speed change: quiet taps stay audible, a smash is full, and it is bounded. */
export function hitGain(speedChange: number): number {
  const t = Math.min(1, Math.max(0, speedChange / PUCK_MAX_SPEED))
  return HIT_FLOOR + (1 - HIT_FLOOR) * Math.sqrt(t)
}

/**
 * The cues one sim tick makes, from the state before it and after it. At most one cue per kind per tick, and a post is not also a rail
 * or a hit. `human` is the player's seat, so a goal is yours or theirs.
 */
export function cuesForTick(prev: Snap, s: PuckState, human: Seat): CueReq[] {
  const out: CueReq[] = []
  const g0 = s.score[0] - prev.s0
  const g1 = s.score[1] - prev.s1
  if (g0 > 0 || g1 > 0 || (s.ev & (1 << PUCK_EVENTS.goal)) !== 0) {
    const mine = (human === 0 ? g0 : g1) > 0
    const theirs = (human === 0 ? g1 : g0) > 0
    if (mine || theirs) {
      out.push({ cue: mine ? 'goalYou' : 'goalThem', gain: 1, delayMs: 0 })
      // The same rule as momentFor: only the goal that takes the scorer to match point (or makes it level there) pulses, not a goal for
      // the other side while someone already sat on 6.
      const scorerGoals = s.score[mine ? human : 1 - human]
      if (scorerGoals === GOALS_TO_WIN - 1 && s.phase !== 2) out.push({ cue: 'matchPoint', gain: 1, delayMs: MATCH_POINT_DELAY_MS })
    }
    return out
  }
  if (prev.sudden === 0 && s.sudden === 1) out.push({ cue: 'matchPoint', gain: 1, delayMs: 0 })
  if (prev.phase === 0 && s.phase === 1) out.push({ cue: 'serve', gain: 1, delayMs: 0 })
  if ((s.ev & (1 << PUCK_EVENTS.post)) !== 0) {
    out.push({ cue: 'post', gain: 1, delayMs: 0 })
    return out
  }
  const dvx = s.pvx - prev.pvx
  const dvy = s.pvy - prev.pvy
  const change = Math.hypot(dvx, dvy)
  if (change < MIN_STRIKE) return out
  let struck = false
  for (let i = 0; i < 2; i++) {
    const m = s.m[i]!
    if (Math.hypot(s.px - m.x, s.py - m.y) <= MALLET_REACH) { struck = true; break }
  }
  if (struck) {
    out.push({ cue: 'hit', gain: hitGain(change), delayMs: 0 })
    return out
  }
  const side = (s.px <= RAIL_REACH || s.px >= 1 - RAIL_REACH) && prev.pvx * s.pvx < 0
  const end = (s.py <= RAIL_REACH || s.py >= 2 - RAIL_REACH) && prev.pvy * s.pvy < 0
  if (side || end) out.push({ cue: 'wall', gain: Math.min(1, 0.35 + change / PUCK_MAX_SPEED), delayMs: 0 })
  return out
}

// ---- voices -------------------------------------------------------------------------------------------------------

/** Clock-time end of every oscillator started or scheduled and not yet finished. */
let live: number[] = []
const lastAt = new Map<PuckCue, number>()

export function resetVoicesForTests(): void {
  live = []
  lastAt.clear()
}

interface Part {
  type: OscillatorType
  from: number
  to: number
  /** Seconds from the cue's start to the partial's start, and its length. */
  at: number
  len: number
  attack: number
  peak: number
}

const semitone = (base: number, n: number): number => base * 2 ** (n / 12)

function partsFor(cue: PuckCue, gain: number): Part[] {
  switch (cue) {
    case 'hit': {
      const lift = 1 + 0.25 * gain
      return [
        { type: 'triangle', from: 520 * lift, to: 300, at: 0, len: 0.08, attack: 0.003, peak: PEAK.hit * gain },
        { type: 'sine', from: 1500 * lift, to: 1100, at: 0, len: 0.03, attack: 0.002, peak: PEAK.hit * gain * 0.35 },
      ]
    }
    case 'wall':
      // The low knock is below what a phone speaker plays, so a quieter partial an octave up carries it there.
      return [
        { type: 'sine', from: 260, to: 165, at: 0, len: 0.1, attack: 0.005, peak: PEAK.wall * gain },
        { type: 'sine', from: 520, to: 330, at: 0, len: 0.08, attack: 0.004, peak: PEAK.wall * gain * 0.45 },
      ]
    case 'post':
      return [
        { type: 'sine', from: 1568, to: 1568, at: 0, len: 0.34, attack: 0.003, peak: PEAK.post },
        { type: 'sine', from: 2349, to: 2349, at: 0, len: 0.2, attack: 0.003, peak: PEAK.post * 0.45 },
      ]
    case 'goalYou':
      return [0, 4, 7].map((n, i): Part => ({ type: 'sine', from: semitone(523.25, n), to: semitone(523.25, n), at: i * 0.09, len: i === 2 ? 0.55 : 0.3, attack: 0.012, peak: PEAK.goal * (i === 2 ? 1 : 0.8) }))
    case 'goalThem':
      return [
        { type: 'sine', from: 330, to: 330, at: 0, len: 0.22, attack: 0.015, peak: PEAK.goal * 0.7 },
        { type: 'sine', from: 247, to: 247, at: 0.16, len: 0.34, attack: 0.015, peak: PEAK.goal * 0.7 },
      ]
    case 'matchPoint':
      // 110 Hz is felt more than heard on a phone, so each pulse carries a quieter partial two octaves up (440 Hz, still a plain sine).
      return [
        { type: 'sine', from: 110, to: 98, at: 0, len: 0.28, attack: 0.02, peak: PEAK.matchPoint },
        { type: 'sine', from: 440, to: 392, at: 0, len: 0.24, attack: 0.02, peak: PEAK.matchPoint * 0.55 },
        { type: 'sine', from: 110, to: 98, at: 0.36, len: 0.34, attack: 0.02, peak: PEAK.matchPoint * 0.85 },
        { type: 'sine', from: 440, to: 392, at: 0.36, len: 0.3, attack: 0.02, peak: PEAK.matchPoint * 0.47 },
      ]
    case 'serve':
      return [{ type: 'sine', from: 880, to: 880, at: 0, len: 0.05, attack: 0.004, peak: PEAK.serve }]
  }
}

/** Starts one oscillator through its own gain. Refused (silently) while MAX_VOICES are sounding. */
function voice(ctx: AudioContext, nowMs: number, delayMs: number, p: Part): void {
  live = live.filter((end) => end > nowMs)
  if (live.length >= MAX_VOICES) return
  live.push(nowMs + delayMs + (p.at + p.len) * 1000)
  const t0 = ctx.currentTime + delayMs / 1000 + p.at
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  osc.type = p.type
  osc.frequency.setValueAtTime(p.from, t0)
  if (p.to !== p.from) osc.frequency.exponentialRampToValueAtTime(p.to, t0 + p.len * 0.8)
  amp.gain.setValueAtTime(0.0001, t0)
  amp.gain.exponentialRampToValueAtTime(Math.max(p.peak * getVolume(), 0.0002), t0 + p.attack)
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + p.len)
  osc.connect(amp)
  amp.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + p.len + 0.02)
}

/** Plays one cue through the shared AudioContext, so mute and volume apply. Rate limited per kind. Silent where Web Audio is missing; never throws. */
export function playPuckCue(req: CueReq, nowMs: number = Date.now()): void {
  try {
    if (isMuted()) return
    const last = lastAt.get(req.cue)
    if (last !== undefined && nowMs - last < GAP_MS[req.cue]) return
    const ctx = sharedAudioContext()
    if (!ctx) return
    lastAt.set(req.cue, nowMs)
    resumeAudioContext()
    for (const p of partsFor(req.cue, Math.min(1, Math.max(0, req.gain)))) voice(ctx, nowMs, req.delayMs, p)
  } catch {
    // never let a sound break a game
  }
}

/** Plays everything one tick sounds like (see cuesForTick). */
export function playTick(prev: Snap, s: PuckState, human: Seat): void {
  for (const r of cuesForTick(prev, s, human)) playPuckCue(r)
}

/** The match result: the shared win or loss stinger, a little after the last goal's cue. A draw (-1) is silent. */
export function playResult(winner: number, human: Seat, delayMs = 600): void {
  if (winner < 0) return
  playStinger(winner === human ? 'win' : 'loss', delayMs)
}
