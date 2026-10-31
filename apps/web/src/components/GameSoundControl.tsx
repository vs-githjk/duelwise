import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { isMusicOn, isMuted, subscribeAudio } from '../lib/audio'
import { SoundSwitches } from './SoundSwitches'

/** The sound button in a game's header: opens a small panel with the Music and Sound effects switches (the same ones as Settings). */
export function GameSoundControl() {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const musicOn = useSyncExternalStore(subscribeAudio, isMusicOn, () => true)
  const muted = useSyncExternalStore(subscribeAudio, isMuted, () => false)
  const allOff = !musicOn && muted
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={allOff ? 'Sound (all off)' : 'Sound'}
        data-testid="game-sound-button"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-line bg-surface text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
      >
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8v4h3l4 3V5L6 8H3Z" />
          {allOff ? <path d="m13.5 7.5 4 5m0-5-4 5" /> : <path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9" />}
        </svg>
      </button>
      {open ? (
        <div id={panelId} role="group" aria-label="Sound" data-testid="game-sound-panel" className="absolute right-0 top-full z-30 mt-2 w-56 rounded-card border border-line bg-surface p-3 shadow-card">
          <SoundSwitches />
        </div>
      ) : null}
    </div>
  )
}
