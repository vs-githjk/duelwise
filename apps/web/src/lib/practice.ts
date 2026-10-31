import { useSyncExternalStore } from 'react'

/**
 * Whether the next match is Practice: the same game, unrated. One flag for the whole site, because a player is on one game page at
 * a time. It starts as Rated every time a game page opens (GameShell clears it on mount and unmount), so Practice is always a choice
 * made on the setup screen, never something that carries over. The flag is only a request: the server stores it when the match
 * starts and reads that stored copy at the finish, so the client cannot decide after the fact that a match was Practice or rated.
 */
let practice = false
const listeners = new Set<() => void>()

export function getPractice(): boolean {
  return practice
}

export function setPractice(next: boolean): void {
  if (practice === next) return
  practice = next
  for (const l of [...listeners]) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function usePractice(): boolean {
  return useSyncExternalStore(subscribe, getPractice, getPractice)
}

/** The words for the badge shown during play, and for the result. */
export const PRACTICE_BADGE = 'Practice, unrated'
export const PRACTICE_RESULT = 'Practice, not rated'
