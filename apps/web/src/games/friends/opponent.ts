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

export type Opponent = { kind: 'agent' } | { kind: 'local'; names: [string, string] } | { kind: 'remote'; link: DuelLink }

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
