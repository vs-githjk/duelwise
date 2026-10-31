import { useId, useSyncExternalStore } from 'react'
import { isMusicOn, isMuted, setMusicOn, setMuted, subscribeAudio } from '../lib/audio'

/** The two sound switches, stored in this browser: Music (background loops) and Sound effects (cues, result stingers and the opponent's spoken line). */
export function SoundSwitches({ className }: { className?: string }) {
  const musicOn = useSyncExternalStore(subscribeAudio, isMusicOn, () => true)
  const muted = useSyncExternalStore(subscribeAudio, isMuted, () => false)
  const idMusic = useId()
  const idSfx = useId()
  return (
    <div className={className ?? 'grid gap-1'}>
      <label htmlFor={idMusic} className="inline-flex min-h-11 cursor-pointer items-center gap-3">
        <input id={idMusic} type="checkbox" role="switch" className="size-5 accent-action" checked={musicOn} onChange={(e) => setMusicOn(e.target.checked)} data-testid="music-switch" />
        <span className="font-medium">Music</span>
      </label>
      <label htmlFor={idSfx} className="inline-flex min-h-11 cursor-pointer items-center gap-3">
        <input id={idSfx} type="checkbox" role="switch" className="size-5 accent-action" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} data-testid="sfx-switch" />
        <span className="font-medium">Sound effects</span>
      </label>
    </div>
  )
}
