import type { GameCore, Seat } from '@duelwise/core/src/types'
import type { GameId } from '@duelwise/core/src/product'
import type { DuelView } from '@duelwise/core/src/duel'

/**
 * A link to a friend on another device (the relay, M4). One port, three suppliers of the other seat's actions: the AI in its worker
 * (`agent`, every page's default), a second person on the same device (`local`) and a second person on another device (`remote`).
 * The messages mirror apps/duel-relay: the client sends `act`, `resign` and `rematch`, the relay answers with `view` and `peer`.
 */
export interface DuelLink {
  send(msg: { t: 'act'; a: number; n: number } | { t: 'resign' } | { t: 'rematch' }): void
  onView(cb: (view: DuelView) => void): () => void
  onPeer(cb: (connected: boolean) => void): () => void
  close(): void
}

/**
 * The link of a two-device realtime match (S8, `useRealtimeLink.ts`): rollback netcode over the relay. The page owns a RollbackSession and
 * feeds it from this link: friend inputs in (`onRemote`), its own held input out (`pushInput`), the relay's snapshot to `session.resync`.
 */
export interface RealtimeLink {
  /** Queues the held input of `frame` (the frame `session.addLocal` returned). Sends a message when the batching rule says one is due. */
  pushInput(frame: number, code: number): void
  /** The friend's codes starting at `frame`, in order, as the relay forwards them. */
  onRemote(cb: (frame: number, codes: number[]) => void): () => void
  /** The relay's state at `frame` when this side's hash differed (or on request after a reconnect), as JSON; pour it with `fromWire`. */
  onSnap(cb: (frame: number, state: unknown) => void): () => void
  /** Attach the hash of the confirmed state at `frame` (a multiple of 60) to the next message. */
  reportHash(frame: number, hash: string): void
  /** Smoothed round trip to the relay in ms, 0 when unknown: feed `session.setRoundTrip` and the ping chip. */
  rtt(): number
  ready(pick?: number): void
  rematch(): void
  resign(): void
  close(): void
}

export type Opponent =
  | { kind: 'agent' }
  | { kind: 'local'; names: [string, string] }
  | { kind: 'remote'; link: DuelLink }
  | { kind: 'remote-rt'; link: RealtimeLink }

/** What a turn game tells the friend screens about itself: its core and the words for its two sides. */
export interface FriendGame {
  id: GameId
  core: GameCore<any, any, any>
  /** What the seat that moves first is called: "White", "the first drop". */
  firstSide: string
  /** The other seat. */
  secondSide: string
  /** The setup question: "Who plays White?". */
  firstQuestion: string
  /** A short line for the setup page, under the name fields. */
  blurb: string
  /** Whether the board can be turned to face the player who is to move. */
  canFlip: boolean
}

export type { Seat }
