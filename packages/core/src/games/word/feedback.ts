/** Marker values: 2 right spot, 1 in the word elsewhere, 0 absent. */
export const WORD_LENGTH = 5

/**
 * Right-spot letters are marked first; every other letter is marked 1 only while the answer still has an
 * unmatched copy of it, so a repeated letter never gets more markers than the answer has copies.
 */
export function feedback(guess: string, answer: string): Uint8Array {
  const out = new Uint8Array(WORD_LENGTH)
  const left = new Uint8Array(26)
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess.charCodeAt(i) === answer.charCodeAt(i)) out[i] = 2
    else left[answer.charCodeAt(i) - 97]!++
  }
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (out[i] === 2) continue
    const c = guess.charCodeAt(i) - 97
    if (left[c]! > 0) {
      out[i] = 1
      left[c]!--
    }
  }
  return out
}

/** Base-3 code of a marker row (0..242), first letter most significant. */
export function patternCode(markers: ArrayLike<number>): number {
  let code = 0
  for (let i = 0; i < WORD_LENGTH; i++) code = code * 3 + markers[i]!
  return code
}

export const ALL_RIGHT = 242 // five 2s in base 3
