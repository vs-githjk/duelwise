import type { Seat } from '@duelwise/core/src/types'

/**
 * The side a test pins in a match made with a fixed test seed (`?seed`), or undefined to take the side the seed gives (core/sides.ts).
 * `?side=0` or `?side=1` pins it; `?side=seed` takes the seed's own side. With no `?side`, the dev server's VITE_DUELWISE_SIDE decides (the
 * e2e server sets it to 0, so a spec written for a player who moves first keeps its seed and its side).
 * Dev builds only: a production build never honours either, and a counted match takes its side from the server.
 */
export function devSide(
  search: string | undefined = typeof window === 'undefined' ? undefined : window.location.search,
  dev: boolean = import.meta.env?.DEV === true,
  fallback: string | undefined = import.meta.env?.VITE_DUELWISE_SIDE,
): Seat | undefined {
  if (!dev || search === undefined) return undefined
  const q = new URLSearchParams(search).get('side') ?? fallback
  return q === '0' ? 0 : q === '1' ? 1 : undefined
}
