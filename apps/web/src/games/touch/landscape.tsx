import { useCallback, useEffect, useRef, useState } from 'react'
import { primeAudio } from '../../lib/audio'
import { primeSpeech } from '../../lib/speech'
import { enterLandscapePlay, isPortraitNow, leaveLandscapePlay, useIsPortrait } from './orientation'

// The orientation pieces (the reading, the overlay, the rotate pause, the screen lock) live in orientation.tsx and are re-exported here, so
// existing imports keep working. They are split out because the speech and audio priming below pulls in more code than a page that only
// needs to follow the orientation (the friend match) should have to load.
export { enterLandscapePlay, isPortraitNow, leaveLandscapePlay, RotateOverlay, useIsPortrait, useReleaseLandscape, useRotatePause } from './orientation'

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
