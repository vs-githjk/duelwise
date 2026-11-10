import { chessCore } from '@duelwise/core/src/games/chess/core'
import type { FriendGame } from '../friends/opponent'

/** Chess for two people on one device. White is seat 0 and moves first. */
export const CHESS_FRIEND: FriendGame = {
  id: 'chess',
  core: chessCore,
  firstSide: 'White',
  secondSide: 'Black',
  firstQuestion: 'Who plays White?',
  blurb: 'Pass the device after each move, or turn the board to whoever is to move. Draws by stalemate, repetition and the fifty-move rule are detected for you.',
  canFlip: true,
}
