/**
 * Whether a match is in progress on this page. The game hooks set it while a match runs and clear it on finish or leave.
 * Anything that would reload or replace the page (a stale-chunk recovery) must wait while it is set.
 */
let active = false
const listeners = new Set<() => void>()

export function isMatchActive(): boolean {
  return active
}

export function setMatchActive(on: boolean): void {
  if (active === on) return
  active = on
  for (const l of [...listeners]) l()
}

/** Calls `fn` whenever the flag changes. Returns the unsubscribe. */
export function subscribeMatchActive(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
