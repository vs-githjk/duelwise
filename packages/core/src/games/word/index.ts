import type { GameCore } from '../../types'
import { wordCore } from './core'

export { wordCore, MAX_GUESSES } from './core'
export type { WordState, WordObs } from './core'
export { feedback, patternCode, ALL_RIGHT, WORD_LENGTH } from './feedback'
export { ALLOWED, ANSWERS, GUESSABLE, GUESS_ONLY, allowedIndex, answerIndex, isAllowed } from './lists'

export const core: GameCore<any, any, any> | null = wordCore
