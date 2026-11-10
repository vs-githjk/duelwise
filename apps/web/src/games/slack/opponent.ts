import { slackCore } from '@duelwise/core/src/games/slack/core'
import type { FriendGame } from '../friends/opponent'

/** Crosscurrent for two people on one device. The dark discs are seat 0 and move first. Open information, so no curtain. */
export const SLACK_FRIEND: FriendGame = {
  id: 'slack',
  core: slackCore,
  firstSide: 'dark',
  secondSide: 'pale',
  firstQuestion: 'Who plays the dark discs?',
  blurb: 'Dark moves first. Place a disc so a line of the other side ends against one of yours and every closed line flips. A side with no move passes by itself.',
  canFlip: false,
}
