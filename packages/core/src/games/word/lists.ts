import { ALLOWED_TEXT, ANSWERS_TEXT, GUESS_ONLY_TEXT } from './lists.generated'

const split = (t: string): string[] => t.split('\n').filter((w) => w.length > 0)

/** Answer words, most common first (the line order of lists/answers.txt). */
export const ANSWERS: readonly string[] = split(ANSWERS_TEXT)
/** The base guess list, alphabetical. Includes every answer. The solver plays from this list only. */
export const ALLOWED: readonly string[] = split(ALLOWED_TEXT)
/**
 * Words a player may guess that are in neither ANSWERS nor ALLOWED (lists/guess-only.txt). Their action index
 * continues after ALLOWED's last, so every index in a stored match record is unchanged. Never reorder.
 */
export const GUESS_ONLY: readonly string[] = split(GUESS_ONLY_TEXT)
/** Every word a player may guess: ALLOWED, then GUESS_ONLY. Position in this list is the encoded action. */
export const GUESSABLE: readonly string[] = [...ALLOWED, ...GUESS_ONLY]

const index = new Map<string, number>()
GUESSABLE.forEach((w, i) => index.set(w, i))
const answerRank = new Map<string, number>()
ANSWERS.forEach((w, i) => answerRank.set(w, i))

/** Position of a word in GUESSABLE (the encoded action; equal to its position in ALLOWED for every ALLOWED word), or -1. */
export function allowedIndex(word: string): number {
  return index.get(word) ?? -1
}

/** True for any word a player may guess, GUESS_ONLY included. */
export function isAllowed(word: string): boolean {
  return index.has(word)
}

/** Position of a word in ANSWERS (0 is the most common), or -1. */
export function answerIndex(word: string): number {
  return answerRank.get(word) ?? -1
}
