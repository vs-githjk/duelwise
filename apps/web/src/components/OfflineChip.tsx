import { useEffect, useSyncExternalStore } from 'react'
import { isOffline, probe, subscribeConnection } from '../lib/connection'

/** True while the server cannot be reached. The server render assumes online, so the chip appears after hydration. */
export function useOnline(): boolean {
  return !useSyncExternalStore(subscribeConnection, isOffline, () => false)
}

/** A small, calm chip while offline: finished matches are kept and sent later. It sits at the top of the screen, off the sticky Start bar, and never takes a tap. */
export function OfflineChip() {
  const online = useOnline()
  // Check once on load, then often while offline (to notice the way back quickly) and rarely while online.
  useEffect(() => {
    let timer = 0
    const tick = () => {
      if (document.visibilityState !== 'hidden') void probe()
      timer = window.setTimeout(tick, isOffline() ? 4000 : 20000)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [])
  if (online) return null
  return (
    <p role="status" data-testid="offline-chip" className="pointer-events-none fixed left-1/2 top-[max(8px,env(safe-area-inset-top))] z-50 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-warn-soft px-3 py-1.5 text-sm font-medium text-warn-ink shadow">
      Offline: matches will sync later
    </p>
  )
}
