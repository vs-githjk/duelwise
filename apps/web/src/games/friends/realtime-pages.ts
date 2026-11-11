import type { ComponentType } from 'react'
import type { RealtimeHandle, RtGame } from './useRealtimeLink'

/** What a two-device realtime game page receives once the relay has said `go`: the live link and its state (seat, seed, names, ping). */
export interface RealtimePageProps {
  handle: RealtimeHandle
  /** Leave the room and go back to the games. */
  onLeave: () => void
}

/**
 * The game pages that can play over the realtime link, by game. Glasscut landed in S9; Tinderbox (S10) and Coldstore (S12) follow.
 * A game with no entry shows "not open on two devices yet" instead of a dead screen.
 */
export const REALTIME_PAGES: Partial<Record<RtGame, () => Promise<{ default: ComponentType<RealtimePageProps> }>>> = {
  puck: () => import('./RemotePuck'),
}
