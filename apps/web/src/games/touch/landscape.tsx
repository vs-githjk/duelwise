import { useCallback, useEffect, useRef, useState } from 'react'
import { primeAudio } from '../../lib/audio'
import { primeSpeech } from '../../lib/speech'

// Tinderbox and Coldstore are played sideways on a phone. This file holds the three pieces both games share:
// the orientation reading, the "turn your phone sideways" overlay, and the gate that holds a match back until
// the phone is in landscape. Android Chrome can also lock the screen to landscape; iOS Safari cannot, so iOS
// relies on the overlay alone.

const PORTRAIT_QUERY = '(orientation: portrait)'

/** True while the window is taller than it is wide: the orientation media query, or the window size where matchMedia is missing. */
export function isPortraitNow(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (typeof matchMedia === 'function') return matchMedia(PORTRAIT_QUERY).matches
  } catch { /* fall through to the size */ }
  return window.innerHeight > window.innerWidth
}

/** Follows the orientation. Old Safari only has addListener on a MediaQueryList, and a resize also counts, so a missing or odd matchMedia never freezes the gate. */
export function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(isPortraitNow)
  useEffect(() => {
    const update = () => setPortrait(isPortraitNow())
    update()
    let mq: MediaQueryList | null = null
    try { mq = typeof matchMedia === 'function' ? matchMedia(PORTRAIT_QUERY) : null } catch { mq = null }
    if (mq?.addEventListener) mq.addEventListener('change', update)
    else mq?.addListener?.(update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      if (mq?.removeEventListener) mq.removeEventListener('change', update)
      else mq?.removeListener?.(update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return portrait
}

/** Counts fullscreen requests, so a late answer to an old one can tell it was cancelled. */
let session = 0

/**
 * Called from the Start tap (a user gesture): asks for fullscreen and a landscape lock where the browser
 * allows it. Android Chrome honours both (the lock needs fullscreen, or an installed app); iOS Safari has
 * neither for pages, so every call is best effort and a refusal is silent.
 */
export function enterLandscapePlay(): void {
  const mine = ++session
  // A request that resolves after the player cancelled (or left) must not leave the screen locked: it hands the screen back at once.
  const lock = () => {
    if (mine !== session) { leaveLandscapePlay(); return }
    try {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      void o?.lock?.('landscape')?.catch(() => undefined)
    } catch { /* no orientation lock here (iOS Safari, desktop) */ }
  }
  try {
    const el = document.documentElement
    if (!document.fullscreenElement && typeof el.requestFullscreen === 'function') {
      el.requestFullscreen({ navigationUI: 'hide' }).then(lock, lock)
      return
    }
  } catch { /* fullscreen refused */ }
  lock()
}

/** Gives the screen back: leaves fullscreen and releases the landscape lock. */
export function leaveLandscapePlay(): void {
  session++
  try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined) } catch { /* ignore */ }
  try { screen.orientation?.unlock?.() } catch { /* ignore */ }
}

/**
 * Holds a match back on a phone held upright. `requestStart(run)` runs `run` at once on desktop or in
 * landscape; in portrait it keeps `run`, shows the overlay (`waiting`) and runs it the moment the phone
 * turns. `cancel` drops the held start.
 */
export function useLandscapeGate(touch: boolean) {
  const portrait = useIsPortrait()
  const held = useRef<(() => void) | null>(null)
  const [waiting, setWaiting] = useState(false)
  const requestStart = useCallback((run: () => void) => {
    if (!touch) { run(); return }
    // Inside the tap, before the overlay: the match may start later, on a rotation, which is not a gesture.
    primeAudio()
    primeSpeech()
    enterLandscapePlay()
    if (isPortraitNow()) { held.current = run; setWaiting(true) } else run()
  }, [touch])
  const cancel = useCallback(() => { held.current = null; setWaiting(false); leaveLandscapePlay() }, [])
  useEffect(() => {
    if (!waiting || portrait) return
    const run = held.current
    held.current = null
    setWaiting(false)
    run?.()
  }, [waiting, portrait])
  return { portrait: touch && portrait, waiting, requestStart, cancel }
}

/**
 * Pauses a running match when a phone turns upright and resumes it when it turns back, unless the player
 * had paused it themselves. `active` is true while a match is loading or being played.
 */
export function useRotatePause(opts: { block: boolean; playing: boolean; paused: boolean; pause: () => void; resume: () => void }) {
  const { block, playing, paused, pause, resume } = opts
  const byRotate = useRef(false)
  useEffect(() => {
    if (block && playing && !paused) { byRotate.current = true; pause() }
    else if (!block && byRotate.current) { byRotate.current = false; if (paused) resume() }
  }, [block, playing, paused, pause, resume])
}

/** Frees the screen lock when the player leaves the match or the page. */
export function useReleaseLandscape(inMatch: boolean, touch: boolean) {
  useEffect(() => {
    if (touch && !inMatch) leaveLandscapePlay()
  }, [inMatch, touch])
  useEffect(() => () => leaveLandscapePlay(), [])
}

export function RotateOverlay({ cancelLabel, onCancel }: { cancelLabel: string; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  return (
    <div className="rotate-ov" role="alertdialog" aria-modal="true" aria-labelledby="rotate-title" aria-describedby="rotate-line" data-testid="rotate-overlay">
      <div className="rotate-card">
        <svg className="rotate-phone" viewBox="0 0 64 64" width="96" height="96" aria-hidden="true" focusable="false">
          <g className="rotate-phone-body">
            <rect x="20" y="6" width="24" height="44" rx="5" fill="none" stroke="currentColor" strokeWidth="3" />
            <line x1="28" y1="11" x2="36" y2="11" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="32" cy="43" r="2" fill="currentColor" />
          </g>
          <path className="rotate-arrow" d="M12 52 C 20 60, 44 60, 52 52" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <path className="rotate-arrow" d="M46 53 L52.5 51.5 L51 58" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h2 id="rotate-title" className="rotate-title">Turn your phone sideways</h2>
        <p id="rotate-line" className="rotate-line">This one is played in landscape. The match starts the moment you turn it.</p>
        <button ref={cancel} type="button" className="rotate-cancel" onClick={onCancel}>{cancelLabel}</button>
      </div>
    </div>
  )
}
