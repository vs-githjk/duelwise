// Background music and the win and loss stingers. The files are CC0 (see public/assets/audio/.../CREDITS.md).
//
// Rules this module keeps:
//   - Music plays only during a match, from Start to the result (decisions.md: match-only). The lobby, landing, setup, leaderboard and every
//     other page are silent. GameShell reports the match on and off (setMatchMusic); the loop fades in on Start and out when the result shows.
//   - Nothing plays before the player's first tap (iOS and Chrome block it); a match that started before the tap begins on the first tap.
//   - One loop per mood: board (chess, four, word), poker (hold'em) and action (Tinderbox, Coldstore). A tab that is hidden is paused.
//   - Music is its own switch (isMusicOn); the stingers and every other cue follow the sound effects switch (isMuted).
//   - A stinger or a spoken line ducks the music and lets it back up after.
//   - iOS ignores an element's volume, so the music goes through a GainNode on the shared AudioContext when there is one.
// Nothing here may throw into a game: every browser call is guarded.

import { getVolume, isMusicOn, isMuted, play, registerSounds, resumeAudioContext, sharedAudioContext, subscribeAudio } from './audio'

export type Mood = 'board' | 'poker' | 'action'
export type StingerOutcome = 'win' | 'loss'

const ROOT = '/assets/audio/opengameart/cc0-music'
export const TRACKS: Record<Mood, string> = {
  board: `${ROOT}/music/board.mp3`,
  poker: `${ROOT}/music/poker.mp3`,
  action: `${ROOT}/music/action.mp3`,
}
const STINGER_URL: Record<StingerOutcome, string> = { win: `${ROOT}/stingers/win.mp3`, loss: `${ROOT}/stingers/loss.mp3` }
/** Length of each stinger file, so the music comes back when it ends. */
const STINGER_MS: Record<StingerOutcome, number> = { win: 2300, loss: 3000 }

const MOOD_BY_GAME: Record<string, Mood> = { chess: 'board', four: 'board', word: 'board', holdem: 'poker', fighter: 'action', arena: 'action', fleet: 'board' }

/** Music level relative to the master volume. */
export const MUSIC_LEVEL = 0.25
/** What the music is multiplied by while a stinger or a spoken line is on. */
export const DUCK_LEVEL = 0.3
const FADE_MS = 1500
const DUCK_DOWN_MS = 150
const DUCK_UP_MS = 900
/** A hold that is never released (a speech that never ends) lets go on its own after this long. */
const MAX_HOLD_MS = 20000

/** Whether a game's match music should be on: an explicit flag from a page that knows its own phase wins, else a picked level with no result yet. */
export function matchMusicWanted(p: { level?: unknown; result?: unknown; matchActive?: boolean }): boolean {
  return p.matchActive ?? (p.level !== undefined && !p.result)
}

/** The loop for a game (by id), or null for a game without one. */
export function moodForGame(game: string): Mood | null {
  return MOOD_BY_GAME[game] ?? null
}

interface Voice {
  el: HTMLAudioElement
  gain: GainNode | null
  /** 0..1, how far this track has faded in. */
  fade: number
}

const voices = new Map<Mood, Voice>()
/** The loop wanted now: set while a match is on, null everywhere else (silence). */
let mood: Mood | null = null
let gestured = false
let hidden = false
/** 1 normal, DUCK_LEVEL while a stinger or a line is on; eased toward duckTarget. */
let duck = 1
let duckTarget = 1
let holds = 0
let ticker: ReturnType<typeof setInterval> | null = null
let stingersRegistered = false
let onBlocked: (() => void) | null = null

function registerStingers(): void {
  if (stingersRegistered) return
  stingersRegistered = true
  registerSounds({ 'stinger-win': STINGER_URL.win, 'stinger-loss': STINGER_URL.loss })
}
registerStingers()

// ---- test hook -----------------------------------------------------------------------------------------------------
// Tests read this instead of listening for real sound. It records what happened and exposes the music state.

export interface AudioEvent {
  type: 'stinger' | 'mood' | 'duck'
  outcome?: StingerOutcome
  /** Stinger: whether it was actually played (false when sound effects are off). */
  played?: boolean
  mood?: Mood | null
  on?: boolean
}
export interface MusicState {
  mood: Mood | null
  gestured: boolean
  hidden: boolean
  musicOn: boolean
  sfxOn: boolean
  duck: number
  /** Moods whose element is playing right now, with how far each has faded in. */
  playing: Partial<Record<Mood, number>>
}
interface TestHook {
  events: AudioEvent[]
  state: () => MusicState
}

export function musicState(): MusicState {
  const playing: Partial<Record<Mood, number>> = {}
  for (const [m, v] of voices) if (!v.el.paused) playing[m] = Math.round(v.fade * 1000) / 1000
  return { mood, gestured, hidden, musicOn: isMusicOn(), sfxOn: !isMuted(), duck: Math.round(duck * 1000) / 1000, playing }
}

function hook(): TestHook | null {
  try {
    const w = window as unknown as { __duelwiseAudio?: TestHook }
    return (w.__duelwiseAudio ??= { events: [], state: musicState })
  } catch {
    return null
  }
}

function record(e: AudioEvent): void {
  const h = hook()
  if (!h) return
  h.events.push(e)
  if (h.events.length > 200) h.events.shift()
}

// ---- gain ------------------------------------------------------------------------------------------------------------

function setOut(v: Voice, level: number): void {
  const out = Math.min(1, Math.max(0, level))
  try {
    if (v.gain) v.gain.gain.value = out
    else v.el.volume = out
  } catch {
    // an element that cannot take a volume stays as it is
  }
}

function targetOf(m: Mood): number {
  return isMusicOn() && gestured && !hidden && m === mood ? 1 : 0
}

function level(v: Voice): number {
  return v.fade * duck * getVolume() * MUSIC_LEVEL
}

/** Moves every fade and the duck toward their targets by `dtMs`, applies the levels, and pauses a track that has faded out. Exported for tests. */
export function tickMusic(dtMs: number): void {
  const dd = duck > duckTarget ? -dtMs / DUCK_DOWN_MS : dtMs / DUCK_UP_MS
  duck = dd < 0 ? Math.max(duckTarget, duck + dd) : Math.min(duckTarget, duck + dd)
  for (const [m, v] of voices) {
    const t = targetOf(m)
    v.fade = t > v.fade ? Math.min(t, v.fade + dtMs / FADE_MS) : Math.max(t, v.fade - dtMs / FADE_MS)
    setOut(v, level(v))
    if (t === 0 && v.fade === 0 && !v.el.paused) {
      try {
        v.el.pause()
      } catch {
        // already stopped
      }
    }
  }
  if (settled() && ticker) {
    clearInterval(ticker)
    ticker = null
  }
}

function settled(): boolean {
  if (duck !== duckTarget) return false
  for (const [m, v] of voices) if (v.fade !== targetOf(m)) return false
  return true
}

function ensureTicker(): void {
  if (ticker || settled() || typeof setInterval === 'undefined') return
  let last = Date.now()
  ticker = setInterval(() => {
    const now = Date.now()
    tickMusic(Math.min(250, now - last))
    last = now
  }, 50)
}

// ---- voices ----------------------------------------------------------------------------------------------------------

function createVoice(m: Mood): Voice | null {
  if (typeof Audio === 'undefined') return null
  try {
    const el = new Audio(TRACKS[m])
    el.loop = true
    el.preload = 'auto'
    let gain: GainNode | null = null
    const ctx = sharedAudioContext()
    if (ctx) {
      try {
        const src = ctx.createMediaElementSource(el)
        gain = ctx.createGain()
        gain.gain.value = 0
        src.connect(gain)
        gain.connect(ctx.destination)
        el.volume = 1
      } catch {
        gain = null
      }
    }
    if (!gain) el.volume = 0
    const v: Voice = { el, gain, fade: 0 }
    voices.set(m, v)
    return v
  } catch {
    return null
  }
}

function startVoice(m: Mood): void {
  const v = voices.get(m) ?? createVoice(m)
  if (!v || !v.el.paused) return
  try {
    const p = v.el.play()
    void p?.catch((e: unknown) => {
      // The browser said no (no tap yet, or a tap it does not count): wait for the next one.
      if ((e as { name?: string })?.name === 'NotAllowedError') {
        gestured = false
        onBlocked?.()
      }
    })
  } catch {
    // a failed play never reaches the game
  }
}

/** Brings the tracks in line with the switches, the mood and the master volume. Safe to call any time. */
function sync(): void {
  for (const m of Object.keys(TRACKS) as Mood[]) {
    if (targetOf(m) > 0) startVoice(m)
  }
  for (const v of voices.values()) setOut(v, level(v))
  ensureTicker()
}

// ---- public: mood, gesture, hidden -----------------------------------------------------------------------------------

/** A match started (a mood) or ended or left (null): that loop fades in, or the playing one fades out. Everything outside a match is silent. */
export function setMatchMusic(next: Mood | null): void {
  if (next === mood) return
  mood = next
  record({ type: 'mood', mood: next })
  sync()
}

/** Call from inside a user gesture: lets the music start (and resumes the shared AudioContext, which iOS keeps suspended until a tap). */
export function unlockMusic(): void {
  gestured = true
  resumeAudioContext()
  sync()
}

function setHidden(h: boolean): void {
  if (hidden === h) return
  hidden = h
  if (h) {
    // A hidden tab is paused at once (timers there are throttled, so a fade would never finish).
    for (const v of voices.values()) {
      v.fade = 0
      setOut(v, 0)
      try {
        v.el.pause()
      } catch {
        // already stopped
      }
    }
  } else {
    resumeAudioContext()
  }
  sync()
}

const GESTURES = ['pointerup', 'click', 'touchend', 'keydown'] as const

/**
 * Starts listening: the first tap or key press unlocks the music, a hidden tab pauses it, and a change in the switches or the volume
 * is applied at once. Returns the undo. Call once from the app root.
 */
export function startMusic(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  hook()
  hidden = document.visibilityState === 'hidden'
  let armed = false
  const onGesture = () => {
    unlockMusic()
    disarm()
    // If the browser refuses the play (some do not count a pointer event), onBlocked re-arms for the next tap.
  }
  const arm = () => {
    if (armed) return
    armed = true
    for (const e of GESTURES) window.addEventListener(e, onGesture, { capture: true, passive: true })
  }
  const disarm = () => {
    if (!armed) return
    armed = false
    for (const e of GESTURES) window.removeEventListener(e, onGesture, { capture: true })
  }
  onBlocked = arm
  if (!gestured) arm()
  const onVisible = () => setHidden(document.visibilityState === 'hidden')
  document.addEventListener('visibilitychange', onVisible)
  const off = subscribeAudio(sync)
  sync()
  return () => {
    disarm()
    document.removeEventListener('visibilitychange', onVisible)
    off()
    onBlocked = null
  }
}

// ---- public: ducking and stingers ------------------------------------------------------------------------------------

/**
 * Lowers the music until the returned function is called (or `ms` passes). Holds stack: the music comes back when the last one lets go.
 * The release can be called more than once.
 */
export function duckMusic(ms = MAX_HOLD_MS): () => void {
  let released = false
  holds++
  if (holds === 1) record({ type: 'duck', on: true })
  duckTarget = DUCK_LEVEL
  ensureTicker()
  const timer = setTimeout(release, Math.min(ms, MAX_HOLD_MS))
  function release() {
    if (released) return
    released = true
    clearTimeout(timer)
    holds = Math.max(0, holds - 1)
    if (holds === 0) {
      duckTarget = 1
      record({ type: 'duck', on: false })
      ensureTicker()
    }
  }
  return release
}

/**
 * The result sound of a match, for every game: plays the win or loss stinger (when sound effects are on) and ducks the music under it.
 * `delayMs` lets a game put it after its own last animation.
 */
export function playStinger(outcome: StingerOutcome, delayMs = 0): void {
  const run = () => {
    const sfx = !isMuted()
    if (sfx) {
      registerStingers()
      play(`stinger-${outcome}`)
      duckMusic(STINGER_MS[outcome] + 300)
    }
    record({ type: 'stinger', outcome, played: sfx })
  }
  if (delayMs > 0) setTimeout(run, delayMs)
  else run()
}

/** Forget everything (tests). */
export function resetMusicForTests(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
  for (const v of voices.values()) {
    try {
      v.el.pause()
    } catch {
      // gone
    }
  }
  voices.clear()
  mood = null
  gestured = false
  hidden = false
  duck = 1
  duckTarget = 1
  holds = 0
  onBlocked = null
  stingersRegistered = false
}
