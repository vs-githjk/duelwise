import { SIZE } from '@duelwise/core/src/games/slack/core'
import type { Seat } from '@duelwise/core/src/types'
import { getVolume, isMuted, resumeAudioContext, sharedAudioContext } from '../../lib/audio'
import { playStinger } from '../../lib/music'

// Crosscurrent cues. Every one is synthesised on the page's shared AudioContext (no files, so nothing to license), so the sound switch and the
// master volume apply the way they do for Stormglass. Win and loss are the shared result stingers, which also duck the board music.
//
//   place   your disc: a firm wooden tap
//   reply   the opponent's disc: lower and hollower, so the answer is heard as someone else's move
//   flip    a short tick per ring of discs turning over, timed to the board's 30 ms per-ring cascade and rising a little each ring
//   corner  a small bell on top of a disc placed in a corner, for either side
//   pass    two soft falling notes
//   draw    two level notes
//
// Levels are matched to Stormglass: its fire shot peaks at about 0.53 of full scale (sample 0.89 at gain 0.6) and its splash at 0.5, so the disc
// cues peak near that and the ripple sits well under them.

export type SlackCue = 'place' | 'reply' | 'flip' | 'pass' | 'corner' | 'win' | 'lose' | 'draw'

/** Peak gain before the master volume. */
export const PEAK = { place: 0.5, reply: 0.42, flip: 0.2, pass: 0.34, corner: 0.36, draw: 0.34 } as const

/** The board's cascade: a ring of discs turns 30 ms after the ring before it, and a flip is at its edge-on midpoint 100 ms in (slack.css sl-flip, 200 ms). */
export const FLIP_STAGGER_MS = 30
export const FLIP_MID_MS = 100
/** Ticks in one ripple, however many discs turn. */
export const MAX_TICKS = 4
/** Oscillators sounding or scheduled at once, across every cue. A move is a disc, a corner bell (two) and a ripple of four. */
export const MAX_VOICES = 8
/** Semitones above the base pitch for each tick of a ripple, so a ripple rises. */
const RIPPLE_STEPS = [0, 2, 4, 7] as const
const CORNERS: readonly number[] = [0, SIZE - 1, SIZE * (SIZE - 1), SIZE * SIZE - 1]

export interface MoveSound {
  cue: SlackCue
  delayMs: number
  /** Ripple ticks: which rung of the rising ripple this tick is. */
  step?: number
}

/** The move as the board draws it: who played, the cell (null for a pass) and the discs that turned. */
export interface HeardMove {
  seat: Seat
  cell: number | null
  flips: number[]
}

/**
 * Which cues a move makes and when. The disc is heard at once; the ripple's ticks land when each ring of discs is edge-on, so what you hear
 * turns over with what you see. A long flip is thinned to MAX_TICKS evenly spaced rings, not one cue per disc. With reduced motion the discs
 * change at once, so the ripple is one tick.
 */
export function soundsForMove(m: HeardMove, humanSeat: Seat, reducedMotion: boolean): MoveSound[] {
  if (m.cell === null) return [{ cue: 'pass', delayMs: 0 }]
  const out: MoveSound[] = [{ cue: m.seat === humanSeat ? 'place' : 'reply', delayMs: 0 }]
  if (CORNERS.includes(m.cell)) out.push({ cue: 'corner', delayMs: 70 })
  if (m.flips.length === 0) return out
  if (reducedMotion) return [...out, { cue: 'flip', delayMs: 40, step: 0 }]
  const r0 = Math.floor(m.cell / SIZE)
  const c0 = m.cell % SIZE
  const rings = [...new Set(m.flips.map((f) => Math.max(Math.abs(Math.floor(f / SIZE) - r0), Math.abs((f % SIZE) - c0))))].sort((a, b) => a - b)
  const picked = rings.length <= MAX_TICKS ? rings : Array.from({ length: MAX_TICKS }, (_, i) => rings[Math.round((i * (rings.length - 1)) / (MAX_TICKS - 1))]!)
  picked.forEach((ring, i) => out.push({ cue: 'flip', delayMs: Math.max(0, ring - 1) * FLIP_STAGGER_MS + FLIP_MID_MS, step: i }))
  return out
}

// ---- voices -------------------------------------------------------------------------------------------------------

/** Wall-clock end of every oscillator started or scheduled and not yet finished. */
let live: number[] = []

export function resetVoicesForTests(): void {
  live = []
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

/** Starts one oscillator through its own gain. Refused (silently) while MAX_VOICES are sounding. */
function voice(ctx: AudioContext, delayMs: number, p: Part): void {
  const now = Date.now()
  live = live.filter((end) => end > now)
  if (live.length >= MAX_VOICES) return
  live.push(now + delayMs + (p.at + p.len) * 1000)
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

const semitone = (base: number, n: number): number => base * 2 ** (n / 12)

function partialsFor(cue: Exclude<SlackCue, 'win' | 'lose'>, step: number): Part[] {
  switch (cue) {
    case 'place':
      return [{ type: 'triangle', from: 420, to: 230, at: 0, len: 0.11, attack: 0.006, peak: PEAK.place }]
    case 'reply':
      return [{ type: 'sine', from: 250, to: 165, at: 0, len: 0.15, attack: 0.012, peak: PEAK.reply }]
    case 'flip':
      return [{ type: 'sine', from: semitone(880, RIPPLE_STEPS[Math.min(step, RIPPLE_STEPS.length - 1)]!), to: semitone(620, RIPPLE_STEPS[Math.min(step, RIPPLE_STEPS.length - 1)]!), at: 0, len: 0.05, attack: 0.004, peak: PEAK.flip }]
    case 'corner':
      return [
        { type: 'sine', from: 1175, to: 1175, at: 0, len: 0.32, attack: 0.006, peak: PEAK.corner },
        { type: 'sine', from: 1760, to: 1760, at: 0, len: 0.2, attack: 0.006, peak: PEAK.corner * 0.5 },
      ]
    case 'pass':
      return [
        { type: 'sine', from: 392, to: 392, at: 0, len: 0.16, attack: 0.012, peak: PEAK.pass },
        { type: 'sine', from: 294, to: 294, at: 0.13, len: 0.22, attack: 0.012, peak: PEAK.pass },
      ]
    case 'draw':
      return [
        { type: 'sine', from: 330, to: 330, at: 0, len: 0.3, attack: 0.02, peak: PEAK.draw },
        { type: 'sine', from: 330, to: 330, at: 0.28, len: 0.4, attack: 0.02, peak: PEAK.draw * 0.8 },
      ]
  }
}

/** Plays one cue through the shared AudioContext, so mute and volume apply. A win or a loss is the shared stinger. Silent where Web Audio is missing; never throws. */
export function playCue(cue: SlackCue, delayMs = 0, step = 0): void {
  if (cue === 'win' || cue === 'lose') return playStinger(cue === 'win' ? 'win' : 'loss', delayMs)
  try {
    if (isMuted()) return
    const ctx = sharedAudioContext()
    if (!ctx) return
    resumeAudioContext()
    for (const p of partialsFor(cue, step)) voice(ctx, delayMs, p)
  } catch {
    // never let a sound break a game
  }
}

/** Plays everything one move sounds like (see soundsForMove). */
export function playMove(m: HeardMove, humanSeat: Seat, reducedMotion = false): void {
  for (const s of soundsForMove(m, humanSeat, reducedMotion)) playCue(s.cue, s.delayMs, s.step ?? 0)
}
