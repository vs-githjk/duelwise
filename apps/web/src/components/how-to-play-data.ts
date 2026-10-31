import type { GameId } from '@duelwise/core/src/product'

type Guide = { goal: string; steps: string[]; controls: { keys: string; action: string }[]; win: string; tip: string }
export const guides: Record<GameId, Guide> = {
  chess: {
    goal: 'Put the opposing king in checkmate.',
    steps: ['You play White and move first.', 'Select a piece, then select a legal destination.', 'Protect your king from check and capture opposing pieces.', 'Choose a piece when your pawn reaches the far side.'],
    controls: [{ keys: 'Mouse or touch', action: 'select or drag a piece' }, { keys: 'Arrow keys', action: 'move between squares' }, { keys: 'Enter or Space', action: 'select a square' }, { keys: 'Escape', action: 'clear selection' }],
    win: 'Win by checkmate. Some positions end in a draw.', tip: 'Look for threats to your king before each move.',
  },
  four: {
    goal: 'Line up four of your discs in a row.',
    steps: ['Take turns choosing a column.', 'Your disc falls to the lowest open space.', 'Make a line across, up and down, or diagonally.'],
    controls: [{ keys: 'Mouse or touch', action: 'choose a column' }, { keys: 'Left or Right', action: 'move between columns' }, { keys: 'Enter or Space', action: 'drop a disc' }, { keys: 'Home or End', action: 'go to an edge' }],
    win: 'The first player to line up four wins. A full board without four is a draw.', tip: 'Watch for a line your opponent can complete next turn.',
  },
  holdem: {
    goal: 'Finish the match with a higher chip total than your opponent.',
    steps: ['Each hand starts with two private cards and forced bets.', 'Use the shared cards as they appear to make your best five card hand.', 'Choose whether to check, bet, call, raise, or fold when available.', 'A hand ends when someone folds or the remaining hands are compared.', 'Every hand starts with 100 chips each. Choose 5, 10, 15 or 30 hands. If a player loses all 100 chips in one hand, the match ends at once and that player loses.', 'You can leave the table after any finished hand. The match is scored on the chips so far and is unrated.'],
    controls: [{ keys: 'Mouse or touch', action: 'choose an action and bet size' }, { keys: 'Tab', action: 'move between controls' }, { keys: 'Enter or Space', action: 'press a button' }],
    win: 'If a player loses all 100 chips in one hand, they lose the match. Otherwise the player ahead in total chips after the last hand wins; equal totals are a draw.', tip: 'You can fold when the cost of staying in is too high.',
  },
  word: {
    goal: 'Solve the same hidden five-letter word before your opponent.',
    steps: ['You and your opponent each have six guesses, one per round.', 'Type a five-letter word and submit it. Refused words cost no guess.', 'A green dot means the right letter in the right spot; a yellow ring means the letter is in the word but in a different spot.', 'A grey dash means that letter has no remaining match in the word. Repeated letters are counted.', 'You see the opponent’s markers but not their letters.'],
    controls: [{ keys: 'Keyboard', action: 'type your guess' }, { keys: 'Enter', action: 'submit your guess' }, { keys: 'Mouse or touch', action: 'select the input and Guess button' }],
    win: 'The first to solve wins. If both solve in the same round, or neither solves, it is a draw.', tip: 'Use the markers from earlier guesses to narrow down your next word.',
  },
  fighter: {
    goal: 'Win more rounds than your opponent in a best of three fight.',
    steps: ['Choose a fighter and start the match.', 'Move, jump, and crouch to avoid attacks.', 'Use attacks and throws to lower your opponent’s health.', 'A round ends when health runs out or the clock reaches zero.'],
    controls: [{ keys: 'Touch', action: 'left stick moves, jumps and crouches; right buttons attack; Pause opens the menu' }, { keys: 'W A S D or arrow keys', action: 'jump, move, and crouch' }, { keys: 'J K L', action: 'light, medium, and heavy attacks' }, { keys: 'U I', action: 'special and surge' }, { keys: 'Space', action: 'throw' }, { keys: 'Escape', action: 'pause' }],
    win: 'The player with more round wins takes the match. At time out, more health wins the round; equal health gives both a round win.', tip: 'Keep an eye on the clock and your health.',
  },
  arena: {
    goal: 'Win rounds against your opponent in Coldstore.',
    steps: ['Buy equipment at the start of each round.', 'Move around the map and aim with your mouse.', 'Fire at your opponent and use cover to stay alive.', 'A round ends when a player is eliminated or time runs out.'],
    controls: [{ keys: 'Touch', action: 'left stick moves; drag the right side to aim; hold Fire to shoot; tap buttons to jump, crouch, reload, view scores or pause' }, { keys: 'W A S D', action: 'move' }, { keys: 'Mouse', action: 'aim; left button fires' }, { keys: 'Space', action: 'jump' }, { keys: 'C or Ctrl', action: 'crouch' }, { keys: 'Shift', action: 'walk' }, { keys: 'R', action: 'reload' }, { keys: 'Tab', action: 'scores' }, { keys: 'Escape', action: 'pause and release the mouse' }],
    win: 'The match ends at seven round wins or after 13 rounds. More round wins takes the match; equal wins are a draw. At time out, more health wins the round.', tip: 'Use cover while you reload.',
  },
}

const seen = new Set<GameId>()
export const storageKey = (game: GameId) => `duelwise.how-to-play.${game}`
export function hasSeenGuide(game: GameId): boolean {
  if (seen.has(game)) return true
  try { return localStorage.getItem(storageKey(game)) === 'seen' } catch { return false }
}
export function markGuideSeen(game: GameId): void {
  seen.add(game)
  try { localStorage.setItem(storageKey(game), 'seen') } catch { /* Keep it for this page session. */ }
}
