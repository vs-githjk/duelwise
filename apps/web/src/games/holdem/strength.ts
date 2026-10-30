import { cardRank, cardSuit } from '@duelwise/core/src/games/holdem/cards'
import { handCategory, rank7 } from '@duelwise/core/src/games/holdem/evaluator'

/** The category after "with", e.g. "You win 12 with a pair". Index is the evaluator's category 0 to 8. */
const WITH = ['a high card', 'a pair', 'two pair', 'three of a kind', 'a straight', 'a flush', 'a full house', 'four of a kind', 'a straight flush'] as const

/** Words for a finished hand's best five of seven, e.g. "a full house". */
export function categoryWords(hole: readonly number[], board: readonly number[]): string {
  return WITH[handCategory(rank7([...hole, ...board]))]!
}

/** "Your hand" line: preflop it describes the two hole cards, after the flop it names the best hand you hold and says which of its ranks are on the table. */
export function handStrength(hole: readonly number[], board: readonly number[], opponent = 'your opponent'): string {
  if (hole.length < 2) return ''
  if (board.length >= 3) return `Your hand: ${teachingName(hole, board, opponent)}`
  const [a, b] = hole as [number, number]
  if (cardRank(a) === cardRank(b)) return 'Your hand: pocket pair'
  return cardSuit(a) === cardSuit(b) ? 'Your hand: two suited cards' : 'Your hand: two unpaired cards'
}

const RANK_ONE = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'] as const
const RANK_MANY = ['twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'] as const

/**
 * A finished hand named the way a dealer would call it: "two pair, kings and fives", "a flush, ace high",
 * "a pair of kings, nine kicker". The ranks are the evaluator's own rank nibbles, so the name always matches
 * the hand that actually won.
 */
export function fullHandName(hole: readonly number[], board: readonly number[]): string {
  const score = rank7([...hole, ...board])
  const nib = (i: number) => (score >> (16 - 4 * i)) & 15
  switch (handCategory(score)) {
    case 0:
      return `${RANK_ONE[nib(0)]} high`
    case 1:
      return `a pair of ${RANK_MANY[nib(0)]}, ${RANK_ONE[nib(1)]} kicker`
    case 2:
      return `two pair, ${RANK_MANY[nib(0)]} and ${RANK_MANY[nib(1)]}`
    case 3:
      return `three ${RANK_MANY[nib(0)]}`
    case 4:
      return `a straight, ${RANK_ONE[nib(0)]} high`
    case 5:
      return `a flush, ${RANK_ONE[nib(0)]} high`
    case 6:
      return `a full house, ${RANK_MANY[nib(0)]} over ${RANK_MANY[nib(1)]}`
    case 7:
      return `four ${RANK_MANY[nib(0)]}`
    default:
      return nib(0) === 12 ? 'a royal flush' : `a straight flush, ${RANK_ONE[nib(0)]} high`
  }
}

/** The ranks that make up the pairs, trips or quads of a hand, each with how many cards of that rank the hand needs. */
function groups(category: number, nib: (i: number) => number): { rank: number; need: number }[] {
  switch (category) {
    case 1:
      return [{ rank: nib(0), need: 2 }]
    case 2:
      return [{ rank: nib(0), need: 2 }, { rank: nib(1), need: 2 }]
    case 3:
      return [{ rank: nib(0), need: 3 }]
    case 6:
      return [{ rank: nib(0), need: 3 }, { rank: nib(1), need: 2 }]
    case 7:
      return [{ rank: nib(0), need: 4 }]
    default:
      return []
  }
}

/** The best hand in words, plus which of it is shared with the opponent because it sits on the board. */
function teachingName(hole: readonly number[], board: readonly number[], opponent: string): string {
  const score = rank7([...hole, ...board])
  const category = handCategory(score)
  const nib = (i: number) => (score >> (16 - 4 * i)) & 15
  const name = fullHandName(hole, board).replace(/, \w+ kicker$/, '')
  const parts = groups(category, nib)
  let onTable: number[]
  if (parts.length > 0) {
    onTable = parts.filter((g) => board.filter((c) => cardRank(c) === g.rank).length >= g.need).map((g) => g.rank)
    if (onTable.length === parts.length) return `${name}, on the table, so ${opponent} has it too`
    if (onTable.length === 0) return name
    return `${name} (the ${RANK_MANY[onTable[0]!]} are on the table, ${opponent} shares them)`
  }
  // Straights, flushes and a high card: the whole hand is shared only when the board alone makes the same five cards.
  if (category > 0 && board.length === 5 && rank7(board) === score) return `${name}, on the table, so ${opponent} has it too`
  return name
}
