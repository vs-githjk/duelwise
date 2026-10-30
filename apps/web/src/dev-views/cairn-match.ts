import { cairnCore, type CairnState } from '@duelwise/core/src/games/template/cairn'
import type { Seat } from '@duelwise/core/src/types'

// Pure match logic for the Cairn template page. No React here, so a unit test can drive a whole match.

export const HUMAN: Seat = 0
export const AGENT_SEAT: Seat = 1

export interface CairnMatch {
  state: CairnState
  /** Every take in order, as [seat, stones]. A real game stores these as the match record's actions. */
  log: Array<[Seat, number]>
}

export function startMatch(seed: number): CairnMatch {
  return { state: cairnCore.init(seed), log: [] }
}

/** Applies one take for the seat to act. Throws on an illegal take, exactly like the core. */
export function applyTake(m: CairnMatch, seat: Seat, take: number): CairnMatch {
  const state = cairnCore.step(m.state, seat === 0 ? [take, null] : [null, take])
  return { state, log: [...m.log, [seat, take]] }
}

export function statusLine(m: CairnMatch, thinkingName: string): string {
  const result = cairnCore.result(m.state)
  if (result) return result.winner === HUMAN ? 'You took the last stone. You win.' : `${thinkingName} took the last stone. You lose.`
  return m.state.turn === HUMAN ? 'Your move: take 1, 2 or 3 stones.' : `${thinkingName} is thinking`
}
