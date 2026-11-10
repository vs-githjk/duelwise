import { wordCore } from '@duelwise/core/src/games/word/core'
import type { FriendGame } from '../friends/opponent'

/** Word Duel for two people on one device. Both guess the same hidden word in the same round, one after the other behind a hand-over screen. */
export const WORD_FRIEND: FriendGame = {
  id: 'word',
  core: wordCore,
  firstSide: 'first',
  secondSide: 'second',
  firstQuestion: 'Who guesses first each round?',
  blurb: 'You both guess the same hidden five-letter word. Type your guess, pass the device, and your friend types theirs. You see how close their guess got, never their letters.',
  canFlip: false,
}
