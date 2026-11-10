import { fleetCore } from '@duelwise/core/src/games/fleet/core'
import type { FriendGame } from '../friends/opponent'

/** Stormglass for two people on one device. Each hides a fleet behind a hand-over screen, then they take turns firing, each turn behind another. */
export const FLEET_FRIEND: FriendGame = {
  id: 'fleet',
  core: fleetCore,
  firstSide: 'first',
  secondSide: 'second',
  firstQuestion: 'Who places and fires first?',
  blurb: 'Each of you hides five ships while the other looks away, then you take turns firing. Pass the device after every shot; the hand-over screen keeps your fleet out of sight.',
  canFlip: false,
}
