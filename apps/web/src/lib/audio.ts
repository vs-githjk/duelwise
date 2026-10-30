// Sound helper shared by every play page. Games register named sounds (CC0 files in public/) and call
// play(name). Master volume and mute persist in localStorage; storage can throw (private windows), so
// every access is wrapped and the helper works without it.

const KEY = 'duelwise.audio'

interface AudioPrefs {
  volume: number
  muted: boolean
}

const listeners = new Set<() => void>()
const sounds = new Map<string, string>()
const buffers = new Map<string, HTMLAudioElement>()
let prefs: AudioPrefs | null = null

function load(): AudioPrefs {
  if (prefs) return prefs
  prefs = { volume: 0.7, muted: false }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<AudioPrefs>
      if (typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1) prefs.volume = v.volume
      if (typeof v.muted === 'boolean') prefs.muted = v.muted
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

/** Re-reads storage on the next call; for tests. */
export function resetAudioForTests(): void {
  prefs = null
  sounds.clear()
  buffers.clear()
}

/** Subscribe to volume and mute changes (useSyncExternalStore friendly). Returns the unsubscribe. */
export function subscribeAudio(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function registerSounds(map: Record<string, string>): void {
  for (const [name, url] of Object.entries(map)) {
    sounds.set(name, url)
    buffers.delete(name)
  }
}

export interface PlayOpts {
  /** Relative gain 0..1, multiplied by the master volume. */
  gain?: number
}

/** Plays a registered sound. Silent when muted, unregistered, or the browser blocks audio. */
export function play(name: string, opts: PlayOpts = {}): void {
  const p = load()
  const url = sounds.get(name)
  if (p.muted || !url || typeof Audio === 'undefined') return
  try {
    let base = buffers.get(name)
    if (!base) {
      base = new Audio(url)
      base.preload = 'auto'
      buffers.set(name, base)
    }
    const el = base.cloneNode(true) as HTMLAudioElement
    el.volume = Math.min(1, Math.max(0, p.volume * (opts.gain ?? 1)))
    void el.play().catch(() => {})
  } catch {
    // never let a sound break a game
  }
}

let primeCtx: AudioContext | null = null

/**
 * Unlocks sound for later. iOS only lets a page make sound after a tap, and Tinderbox and Coldstore start on a phone turning
 * (not a tap), so the Start tap calls this: it resumes one shared AudioContext with a silent blip and plays every registered
 * sound once, muted, so the first real cue after the auto-start is allowed. Never throws and never makes an audible sound.
 */
export function primeAudio(): void {
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctx = w.AudioContext ?? w.webkitAudioContext
    if (Ctx) {
      primeCtx ??= new Ctx()
      void primeCtx.resume?.()
      const src = primeCtx.createBufferSource()
      src.buffer = primeCtx.createBuffer(1, 1, 22050)
      src.connect(primeCtx.destination)
      src.start(0)
    }
  } catch {
    // no Web Audio here
  }
  if (typeof Audio === 'undefined') return
  for (const [name, url] of sounds) {
    try {
      let base = buffers.get(name)
      if (!base) {
        base = new Audio(url)
        base.preload = 'auto'
        buffers.set(name, base)
      }
      const el = base
      el.muted = true
      void el.play().then(() => { el.pause(); el.currentTime = 0; el.muted = false }, () => { el.muted = false })
    } catch {
      // a blocked element is simply not unlocked
    }
  }
}
