// Sound helper shared by every play page. Games register named sounds (CC0 files in public/) and call
// play(name). Master volume, the sound effects switch and the music switch persist in localStorage; storage can
// throw (private windows), so every access is wrapped and the helper works without it. Background music itself
// lives in music.ts and reads these preferences.

const KEY = 'duelwise.audio'

interface AudioPrefs {
  volume: number
  /** Sound effects off. (The name is older than the music switch; the opponent's spoken line follows it too.) */
  muted: boolean
  /** Background music on. Defaults to on; it still waits for the first tap. */
  music: boolean
}

const listeners = new Set<() => void>()
const sounds = new Map<string, string>()
let prefs: AudioPrefs | null = null

function load(): AudioPrefs {
  if (prefs) return prefs
  prefs = { volume: 0.7, muted: false, music: true }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<AudioPrefs>
      if (typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1) prefs.volume = v.volume
      if (typeof v.muted === 'boolean') prefs.muted = v.muted
      if (typeof v.music === 'boolean') prefs.music = v.music
    }
  } catch {
    // storage unavailable or corrupt: keep defaults
  }
  return prefs
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable: the choice lasts for this page view only
  }
  for (const l of listeners) l()
}

export const getVolume = (): number => load().volume
export const isMuted = (): boolean => load().muted

export function setVolume(v: number): void {
  load().volume = Math.min(1, Math.max(0, v))
  save()
}

export function setMuted(m: boolean): void {
  load().muted = m
  save()
}

export const isMusicOn = (): boolean => load().music

export function setMusicOn(on: boolean): void {
  load().music = on
  save()
}

/** Re-reads storage on the next call; for tests. */
export function resetAudioForTests(): void {
  prefs = null
  primeCtx = null
  lastResume = -Infinity
  sounds.clear()
  pools.clear()
}

/** Subscribe to volume and mute changes (useSyncExternalStore friendly). Returns the unsubscribe. */
export function subscribeAudio(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function registerSounds(map: Record<string, string>): void {
  for (const [name, url] of Object.entries(map)) {
    sounds.set(name, url)
    pools.delete(name)
  }
}

export interface PlayOpts {
  /** Relative gain 0..1, multiplied by the master volume. */
  gain?: number
  /** Playback rate; below 1 lowers the pitch. Left alone when not given. */
  rate?: number
}

const POOL_SIZE = 3
/** Elements a tap has already started once (unlocked), and each element's latest prime or cue number, so an old prime callback can tell a later cue took over. */
const unlocked = new WeakSet<HTMLAudioElement>()
const stamp = new WeakMap<HTMLAudioElement, number>()
let stampCounter = 0
/** Per sound: a few elements that are reused for every cue. iOS ties permission to the element a tap played, so a cue plays through one of these, never a fresh clone. */
const pools = new Map<string, HTMLAudioElement[]>()

function poolFor(name: string, url: string): HTMLAudioElement[] {
  let pool = pools.get(name)
  if (!pool) {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const el = new Audio(url)
      el.preload = 'auto'
      return el
    })
    pools.set(name, pool)
  }
  return pool
}

/** Plays a registered sound. Silent when muted, unregistered, or the browser blocks audio. */
export function play(name: string, opts: PlayOpts = {}): void {
  const p = load()
  const url = sounds.get(name)
  if (p.muted || !url || typeof Audio === 'undefined') return
  try {
    const pool = poolFor(name, url)
    // A free element if there is one; when every one is busy the oldest restarts (a cue fired three times at once is one burst anyway).
    const el = pool.find((e) => e.paused || e.ended) ?? pool[0]!
    el.volume = Math.min(1, Math.max(0, p.volume * (opts.gain ?? 1)))
    stamp.set(el, ++stampCounter) // a prime still waiting on this element must not pause this cue
    el.muted = false
    if (opts.rate !== undefined) {
      // Browsers keep the pitch when the rate changes unless told not to.
      el.preservesPitch = false
      el.playbackRate = opts.rate
    }
    try { el.currentTime = 0 } catch { /* not seekable yet */ }
    void el.play().catch(() => {})
  } catch {
    // never let a sound break a game
  }
}

let primeCtx: AudioContext | null = null

let lastResume = -Infinity

/**
 * Resumes the shared AudioContext, at most once a second. A tap fires pointerup then click, and both the music's unlock and primeAudio
 * call this; one resume is enough. The music asks only when the context is not already running; the Start tap's prime always asks.
 */
export function resumeAudioContext(opts: { always?: boolean } = {}): void {
  const ctx = sharedAudioContext()
  if (!ctx || (!opts.always && ctx.state === 'running')) return
  const now = Date.now()
  if (now - lastResume < 1000) return
  lastResume = now
  try {
    void ctx.resume?.()
  } catch {
    // no Web Audio
  }
}

/** The one AudioContext the page shares (the unlock blip, and the music's gain stage, which iOS needs because it ignores element volume). Null where Web Audio is missing. */
export function sharedAudioContext(): AudioContext | null {
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctx = w.AudioContext ?? w.webkitAudioContext
    if (!Ctx) return null
    primeCtx ??= new Ctx()
    return primeCtx
  } catch {
    return null
  }
}

/**
 * Unlocks sound for later. iOS only lets a page make sound after a tap, and Tinderbox and Coldstore start on a phone turning
 * (not a tap), so the Start tap calls this: it resumes one shared AudioContext with a silent blip and plays every registered
 * sound once, muted, so the first real cue after the auto-start is allowed. Never throws and never makes an audible sound.
 */
export function primeAudio(): void {
  try {
    const ctx = sharedAudioContext()
    if (ctx) {
      resumeAudioContext({ always: true })
      const src = ctx.createBufferSource()
      src.buffer = ctx.createBuffer(1, 1, 22050)
      src.connect(ctx.destination)
      src.start(0)
    }
  } catch {
    // no Web Audio here
  }
  if (typeof Audio === 'undefined') return
  for (const [name, url] of sounds) {
    try {
      // Every element a later cue will play through is started once here, muted, inside the tap. One already unlocked, or still playing a cue
      // (a rematch tap can land while the last sound rings), is left alone; a late answer from a prime never touches an element a cue has since used.
      for (const el of poolFor(name, url)) {
        if (unlocked.has(el) || !el.paused) continue
        const mine = ++stampCounter
        stamp.set(el, mine)
        el.muted = true
        void el.play().then(
          () => {
            if (stamp.get(el) !== mine) return
            unlocked.add(el)
            el.pause()
            el.currentTime = 0
            el.muted = false
          },
          () => { if (stamp.get(el) === mine) el.muted = false },
        )
      }
    } catch {
      // a blocked element is simply not unlocked
    }
  }
}
