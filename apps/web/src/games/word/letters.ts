export interface LetterStates {
  /** Letters known to be in the word and in the right spot in at least one row. */
  placed: string[]
  /** Letters in the word but only seen in the wrong spot so far. */
  elsewhere: string[]
  /** Letters that are not in the word. */
  out: string[]
}

/**
 * What the player's own guesses have settled about each letter, alphabetical in each group. A letter
 * is ruled out only when no guess marked any copy of it as in the word (a repeated letter can show an
 * absent marker next to a found one). Letters not yet tried are not listed, so this is a record, not a keyboard.
 */
export function letterStates(words: string[], marks: number[][]): LetterStates {
  const best = new Map<string, number>()
  words.forEach((w, r) => {
    for (let i = 0; i < w.length; i++) {
      const c = w[i]!
      const k = marks[r]?.[i] ?? 0
      best.set(c, Math.max(best.get(c) ?? 0, k))
    }
  })
  const sorted = [...best.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  return {
    placed: sorted.filter(([, k]) => k === 2).map(([c]) => c),
    elsewhere: sorted.filter(([, k]) => k === 1).map(([c]) => c),
    out: sorted.filter(([, k]) => k === 0).map(([c]) => c),
  }
}
