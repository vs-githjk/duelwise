import { penaltyCore } from '@duelwise/core/src/games/penalty/core'
import type { FriendGame } from '../friends/opponent'

/** Twelve Yards for two people on one device. Seat 0 kicks first; the roles swap every kick and both picks are hidden until the second is in. */
export const PENALTY_FRIEND: FriendGame = {
  id: 'penalty',
  core: penaltyCore,
  firstSide: 'first',
  secondSide: 'second',
  firstQuestion: 'Who kicks first?',
  blurb: 'Five kicks each. Each kick, the shooter and the keeper choose in secret, one after the other behind a hand-over screen, and the two picks are revealed together.',
  canFlip: false,
}
