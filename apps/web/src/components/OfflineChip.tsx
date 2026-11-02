import { useRouterState } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import { PRODUCT } from '@duelwise/core/src/product'
import { isOffline, probe, subscribeConnection } from '../lib/connection'

/** True while the server cannot be reached. The server render assumes online, so the chip appears after hydration. */
export function useOnline(): boolean {
  return !useSyncExternalStore(subscribeConnection, isOffline, () => false)
}

const STORMGLASS_PATH = `/play/${PRODUCT.games.fleet.slug}`
const CHIP_CORNER = 'bottom-3 left-3'
const CHIP_TOP = 'pointer-events-none left-1/2 top-[max(8px,env(safe-area-inset-top))] -translate-x-1/2 whitespace-nowrap'

/**
 * A small, calm chip while offline: finished matches are kept and sent later. Every page keeps the corner it always had (bottom left);
 * only Stormglass moves it to the top of the screen, off its sticky Start bar, and there it never takes a tap.
 */
export function OfflineChip() {
  const online = useOnline()
  const onStormglass = useRouterState({ select: (s) => s.location.pathname.startsWith(STORMGLASS_PATH) })
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
    <p role="status" data-testid="offline-chip" className={`fixed z-50 rounded-full border border-line bg-warn-soft px-3 py-1.5 text-sm font-medium text-warn-ink shadow ${onStormglass ? CHIP_TOP : CHIP_CORNER}`}>
      {onStormglass ? 'Offline: Practice only' : 'Offline: matches will sync later'}
    </p>
  )
}
