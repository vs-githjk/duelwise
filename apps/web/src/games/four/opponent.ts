import { fourCore } from '@duelwise/core/src/games/four/core'
import type { FriendGame } from '../friends/opponent'

/** Four in a Row for two people on one device. Seat 0 drops first. */
export const FOUR_FRIEND: FriendGame = {
  id: 'four',
  core: fourCore,
  firstSide: 'yellow',
  secondSide: 'black',
  firstQuestion: 'Who drops first?',
  blurb: 'Take turns on the same screen. The first to line up four, across, down or diagonally, wins.',
  canFlip: false,
}
