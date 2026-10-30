import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { ANSWERS } from '@duelwise/core/src/games/word/lists'
import { feedback } from '@duelwise/core/src/games/word/feedback'
import type { Moment, WordRow } from './types'
import { walk } from './walk'

export interface WordReport {
  rows: WordRow[]
  moments: Moment[]
}

const plural = (n: number): string => (n === 1 ? '1 word' : `${n} words`)

export function wordGainTag(gain: number, nextGain: number, remaining: number): 'least helpful' | 'smallest gain' {
  return remaining > 1 && Number.isFinite(nextGain) && gain * 2 <= nextGain && nextGain > gain ? 'least helpful' : 'smallest gain'
}

export function wordGuessCopy(guess: string, remaining: number, opponentRemaining: number, round: number, opponent: string, previous?: number): { text: string; value: string } {
  const detail = previous === 1 ? `${guess} was played when already only one word fit.` : `${guess} left ${plural(remaining)} that fit.`
  return { text: `${detail} ${opponent} had ${plural(opponentRemaining)} after guess ${round}.`, value: `${remaining} left` }
}

/**
 * Guess by guess against the AI. After each guess the report counts the answers that still fit every
 * marker row so far, for each seat: the fewer, the more the guess taught its player.
 */
export function wordReport(rec: MatchRecordV1, answer: string, reason: string, opponent: string): WordReport {
  const steps = walk<unknown, string>(rec)
  const rows: WordRow[] = []
  const left: [string[], string[]] = [[...ANSWERS], [...ANSWERS]]
  const counts: Array<[number, number]> = []
  steps.forEach((st) => {
    const now: [number, number] = [left[0].length, left[1].length]
    for (const m of st.moves) {
      const markers = Array.from(feedback(m.action, answer))
      rows.push({ seat: m.seat === rec.humanSeat ? 'player' : 'ai', guess: m.action, markers })
      const key = markers.join('')
      left[m.seat] = left[m.seat].filter((w) => feedback(m.action, w).join('') === key)
      now[m.seat] = left[m.seat].length
    }
    counts.push(now)
  })
  const me = rec.humanSeat
  const you = counts.map((c) => c[me])
  const them = counts.map((c) => c[(1 - me) as 0 | 1])
  const moments: Moment[] = []
  const gain = (arr: number[], i: number): number => (i === 0 ? ANSWERS.length : arr[i - 1]!) - arr[i]!
  if (you.length > 1) {
    let best = 0
    let worst = 1
    for (let i = 0; i < you.length - 1; i++) {
      const g = gain(you, i)
      if (g > gain(you, best)) best = i
    }
    for (let i = 1; i < you.length - 1; i++) if (gain(you, i) < gain(you, worst)) worst = i
    const g = (i: number) => rows.filter((r) => r.seat === 'player')[i]!.guess.toUpperCase()
    const bestCopy = wordGuessCopy(g(best), you[best]!, them[best]!, best + 1, opponent, best > 0 ? you[best - 1] : undefined)
    moments.push({ kind: 'best', label: `Guess ${best + 1}`, tag: 'best guess', ...bestCopy, valueLabel: 'words' })
    if (you.length > 2 && worst !== best) {
      const worstText = you[worst - 1] === 1 ? `${g(worst)} was played when already only one word fit.` : `${g(worst)} narrowed ${plural(you[worst - 1]!)} to ${plural(you[worst]!)}.`
      moments.push({ kind: 'worst', label: `Guess ${worst + 1}`, tag: wordGainTag(gain(you, worst), Math.min(...Array.from({ length: you.length - 2 }, (_, i) => i + 1).filter((i) => i !== worst).map((i) => gain(you, i))), you[worst]!), text: worstText, value: `${you[worst]} left`, valueLabel: 'words' })
    }
  }
  moments.push({ kind: 'end', label: `Round ${steps.length}`, tag: 'result', text: `${reason} The word was ${answer.toUpperCase()}.` })
  return { rows, moments }
}
