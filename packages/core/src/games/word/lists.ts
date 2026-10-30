import { ALLOWED_TEXT, ANSWERS_TEXT } from './lists.generated'

const split = (t: string): string[] => t.split('\n').filter((w) => w.length > 0)

/** Answer words, most common first (the line order of lists/answers.txt). */
export const ANSWERS: readonly string[] = split(ANSWERS_TEXT)
/** Every word a player may guess, alphabetical. Includes every answer. */
export const ALLOWED: readonly string[] = split(ALLOWED_TEXT)

const index = new Map<string, number>()
ALLOWED.forEach((w, i) => index.set(w, i))
const answerRank = new Map<string, number>()
ANSWERS.forEach((w, i) => answerRank.set(w, i))

/** Position of a word in ALLOWED (the encoded action), or -1. */
export function allowedIndex(word: string): number {
  return index.get(word) ?? -1
}

export function isAllowed(word: string): boolean {
  return index.has(word)
}

/** Position of a word in ANSWERS (0 is the most common), or -1. */
export function answerIndex(word: string): number {
  return answerRank.get(word) ?? -1
}
