import { useRouterState } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import { PRODUCT } from '@duelwise/core/src/product'
import { isOffline, probe, subscribeConnection } from '../lib/connection'
import { isRatedLive, subscribeRatedLive } from '../lib/match-active'

/** True while the server cannot be reached. The server render assumes online, so the chip appears after hydration. */
export function useOnline(): boolean {
  return !useSyncExternalStore(subscribeConnection, isOffline, () => false)
}

/** What the chip says (`onStormglass` is true on any page that draws its own pill: Stormglass and Crosscurrent). Stormglass setup cannot start a rated match offline; a rated match already running there is only waiting for the connection. Every other page keeps its line. */
export function chipText(onStormglass: boolean, ratedLive: boolean, unrated = false): string {
  if (unrated) return 'Offline: matches are not counted'
  if (!onStormglass) return 'Offline: matches will sync later'
  return ratedLive ? 'Offline: reconnecting' : 'Offline: Practice only'
}

/** Pages whose games are rated only with a connection but still play offline, as a local match that counts nowhere (rated-path.ts NO_OFFLINE_TICKETS). */
const UNRATED_OFFLINE_PATHS = [PRODUCT.games.chess, PRODUCT.games.four, PRODUCT.games.holdem].map((g) => `/play/${g.slug}`)
export const isUnratedOfflinePath = (pathname: string): boolean => UNRATED_OFFLINE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

/** The pill itself, for a page that shows it in its own flow (Stormglass, Crosscurrent) so it can never cover the header, the opponent or a button. */
export function OfflinePill({ text }: { text: string }) {
  return (
    <p role="status" data-testid="offline-chip" className="w-fit max-w-full rounded-full border border-line bg-warn-soft px-3 py-1.5 text-sm font-medium text-warn-ink shadow">
      {text}
    </p>
  )
}

/** Games that cannot start a rated match offline and draw their own pill inside the page. Every other game keeps the fixed chip. */
const OWN_PILL_PATHS = [`/play/${PRODUCT.games.fleet.slug}`, `/play/${PRODUCT.games.slack.slug}`]
export const drawsOwnOfflinePill = (pathname: string): boolean => OWN_PILL_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
const CHIP_CORNER = 'bottom-3 left-3'

/**
 * A small, calm chip while offline: finished matches are kept and sent later. Every page keeps the corner it always had (bottom left).
 * Stormglass draws its own pill inside the page instead (see OfflinePill), where nothing can sit under it: a fixed chip covered the header and the opponent on a phone.
 */
export function OfflineChip() {
  const online = useOnline()
  const ratedLive = useSyncExternalStore(subscribeRatedLive, isRatedLive, () => false)
  const ownPill = useRouterState({ select: (s) => drawsOwnOfflinePill(s.location.pathname) })
  const unrated = useRouterState({ select: (s) => isUnratedOfflinePath(s.location.pathname) })
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
  if (online || ownPill) return null
  return (
    <p role="status" data-testid="offline-chip" className={`fixed z-50 rounded-full border border-line bg-warn-soft px-3 py-1.5 text-sm font-medium text-warn-ink shadow ${CHIP_CORNER}`}>
      {chipText(false, ratedLive, unrated)}
    </p>
  )
}
