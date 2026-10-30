import type { HandSummary } from '@duelwise/core/src/games/holdem/match'

/**
 * The numbers in the "Hand N of 30" and "Chips" header. The core steps to the next hand the moment a hand ends, but
 * the table holds the finished hand for a beat, so until the pot has been pushed the header keeps showing the hand
 * on the table and the chips from before it.
 */
export function progressNumbers(
  state: { hand: number; net: [number, number] },
  reveal: { stage: 'runout' | 'show' | 'push'; summary: Pick<HandSummary, 'hand' | 'delta'> } | null,
): { hand: number; net: number } {
  if (reveal && reveal.stage !== 'push') return { hand: reveal.summary.hand + 1, net: state.net[0] - reveal.summary.delta }
  return { hand: state.hand + 1, net: state.net[0] }
}

/** The chip change of a finished hand in words, from the human's side, for the history list's accessible label. */
export function deltaWords(delta: number): string {
  if (delta === 0) return 'No chips changed hands'
  return delta > 0 ? `You gained ${delta} chips` : `You lost ${-delta} chips`
}
