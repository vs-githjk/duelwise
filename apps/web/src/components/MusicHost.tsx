import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { moodForPath, setMood, startMusic } from '../lib/music'

/** Keeps the background music in step with the page: starts it on the first tap, switches the loop with the route, pauses in a hidden tab. Renders nothing. */
export function MusicHost() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => startMusic(), [])
  useEffect(() => {
    setMood(moodForPath(pathname))
  }, [pathname])
  return null
}
