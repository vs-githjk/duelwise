import { raceProgress } from './ledger'

const SAY = ['not in the word', 'in the word but the wrong spot', 'in the right spot'] as const

export interface RoundFacts {
  /** My words so far, oldest first, with their marker rows. */
  mine: string[]
  myRows: number[][]
  oppName: string
  /** The opponent's marker rows so far: its letters are never announced. */
  oppRows: number[][]
  max: number
}

/**
 * What a screen reader says after each round: my latest guess letter by letter, then how close the
 * opponent got, from the marker rows both sides can see. Empty before the first guess.
 */
export function roundAnnouncement(f: RoundFacts): string {
  const n = f.mine.length
  if (n === 0) return ''
  const word = f.mine[n - 1]!
  const row = f.myRows[n - 1] ?? []
  const letters = Array.from(word).map((c, i) => `${c.toUpperCase()} ${SAY[row[i] ?? 0]}`).join(', ')
  const me = raceProgress(f.myRows)
  const them = raceProgress(f.oppRows)
  const parts = [`Round ${n} of ${f.max}.`, `You guessed ${word.toUpperCase()}: ${letters}.`]
  if (me.solved) parts.push('You solved the word.')
  if (them.solved) parts.push(`${f.oppName} solved the word.`)
  else if (f.oppRows.length > 0) parts.push(`${f.oppName}: ${them.placed} of 5 letters in the right spot in its best row.`)
  return parts.join(' ')
}
