import { puckCore } from '@duelwise/core/src/games/puck/core'
import type { FriendGame } from '../friends/opponent'

/** Glasscut for two people on one device. Seat 0 defends the bottom end. */
export const PUCK_FRIEND: FriendGame = {
  id: 'puck',
  core: puckCore,
  firstSide: 'the bottom end',
  secondSide: 'the top end',
  firstQuestion: 'Who sits at the bottom?',
  blurb: 'Lay the phone flat between you. Each of you puts a thumb on your own half and drags: the mallet sits just ahead of your finger. First to 7 goals.',
  canFlip: false,
}
