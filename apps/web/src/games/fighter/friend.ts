import { fighterCore } from '@duelwise/core/src/games/fighter/core'
import type { FriendGame } from '../friends/opponent'

/** Tinderbox for two people on one device. Seat 0 starts on the left. */
export const FIGHTER_FRIEND: FriendGame = {
  id: 'fighter',
  core: fighterCore,
  firstSide: 'the left',
  secondSide: 'the right',
  firstQuestion: 'Who starts on the left?',
  blurb: 'One keyboard, two gamepads or a tablet. Best of 3 rounds, 99 seconds each, the same moves for both of you.',
  canFlip: false,
}

/** One line per player for the setup and pause screens. Keys are the physical ones, so the layout does not matter. */
export const KEY_LINES = {
  one: 'W A S D to move, F G H for light, medium and heavy, R special, T surge, Y throw.',
  two: 'Arrow keys to move, J K L for light, medium and heavy, U special, I surge, O throw.',
  pause: 'Esc or P pauses.',
} as const

export const GAMEPAD_LINE = 'Gamepads: the first pad you connect is player one and the second is player two. Stick or d-pad moves, X light, Y medium, RB heavy, A special, B surge, RT throw, Start pauses. Press a button on each pad if the game does not see it.'
