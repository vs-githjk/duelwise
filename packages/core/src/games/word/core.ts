import type { GameCore, Result, Seat } from '../../types'
import { hashState } from '../../hash'
import { makeRng } from '../../rng'
import { feedback } from './feedback'
import { ANSWERS, GUESSABLE, allowedIndex, answerIndex, isAllowed } from './lists'

export const MAX_GUESSES = 6

export interface WordState {
  answer: string
  /** Guesses of each seat, one per round; both seats always have the same count. */
  guesses: [string[], string[]]
}

export interface WordObs {
  round: number
  maxGuesses: number
  /** Your own guesses and the marker rows they earned. */
  guesses: string[]
  feedback: number[][]
  /** The other seat's marker rows only, never its letters. */
  opponent: number[][]
  /** The hidden word once the game is over, otherwise null. */
  answer: string | null
}

const markers = (guess: string, answer: string): number[] => Array.from(feedback(guess, answer))
const solvedAt = (s: WordState, seat: Seat): number => s.guesses[seat].indexOf(s.answer)

function isOver(s: WordState): boolean {
  return solvedAt(s, 0) >= 0 || solvedAt(s, 1) >= 0 || s.guesses[0].length >= MAX_GUESSES
}

/**
 * Word Duel: both seats guess the same hidden word in simultaneous rounds, up to six guesses each. The
 * game ends after the first round in which someone solves it, or after round six. A lone solver wins;
 * solving in the same round, or neither solving, is a draw. A tick is one round and both seats act in it.
 * `init` takes an optional `answer` (measurement and tests); otherwise the seed picks one from the answer list.
 */
export const wordCore: GameCore<WordState, string, WordObs> = {
  id: 'word',
  version: 'word-3',
  init(seed, opts) {
    const wanted = opts?.answer
    if (typeof wanted === 'string') {
      if (answerIndex(wanted) < 0) throw new Error(`word: ${wanted} is not in the answer list`)
      return { answer: wanted, guesses: [[], []] }
    }
    return { answer: ANSWERS[makeRng(seed).int(ANSWERS.length)]!, guesses: [[], []] }
  },
  toAct: (s) => (isOver(s) ? [] : [0, 1]),
  legal: (s) => (isOver(s) ? [] : (GUESSABLE as string[])),
  step(s, actions) {
    if (isOver(s)) throw new Error('word: the game is over')
    const next: [string[], string[]] = [[...s.guesses[0]], [...s.guesses[1]]]
    for (const seat of [0, 1] as const) {
      const g = actions[seat]
      if (g === null || g === undefined) throw new Error(`word: missing guess for seat ${seat}`)
      if (!isAllowed(g)) throw new Error(`word: ${g} is not an allowed guess`)
      next[seat].push(g)
    }
    return { answer: s.answer, guesses: next }
  },
  terminal: isOver,
  result(s): Result | null {
    if (!isOver(s)) return null
    const a = solvedAt(s, 0)
    const b = solvedAt(s, 1)
    if (a >= 0 && b >= 0) return { winner: null, score: [0.5, 0.5], reason: 'both solved in the same round' }
    if (a >= 0) return { winner: 0, score: [1, 0], reason: 'solved first' }
    if (b >= 0) return { winner: 1, score: [0, 1], reason: 'solved first' }
    return { winner: null, score: [0.5, 0.5], reason: 'neither solved' }
  },
  observe(s, seat) {
    const other = (1 - seat) as Seat
    return {
      round: s.guesses[seat].length,
      maxGuesses: MAX_GUESSES,
      guesses: [...s.guesses[seat]],
      feedback: s.guesses[seat].map((g) => markers(g, s.answer)),
      opponent: s.guesses[other].map((g) => markers(g, s.answer)),
      answer: isOver(s) ? s.answer : null,
    }
  },
  hash: (s) => hashState({ answer: s.answer, guesses: s.guesses }),
  encodeAction(a) {
    const i = allowedIndex(a)
    if (i < 0) throw new Error(`word: ${a} is not an allowed guess`)
    return i
  },
  decodeAction(n) {
    const w = GUESSABLE[n]
    if (w === undefined) throw new Error(`word: no allowed word at index ${n}`)
    return w
  },
}
