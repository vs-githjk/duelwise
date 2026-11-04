import type { PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import { TurnRefused } from '../fleet/api'

export { TurnRefused }

/** One answer of the server for a counted Twelve Yards match: the player's own view with the kick just played, and the seed and the opponent's picks only once it is over. */
export interface PenaltyTurnReply {
  view: PenaltyObs
  over: boolean
  reveal?: { seed: number; agentActions: number[]; entropy?: number[] }
}

/** Sends every pick I have made so far, one per kick; the server picks the opponent's for the newest kick only after it has that pick, and answers with my view. A retried request gets the same answer. */
export type FetchTurn = (matchId: string, actions: number[]) => Promise<PenaltyTurnReply>

/** The real call: the server function, loaded on first use so this file stays free of server code. */
export const serverFetchTurn: FetchTurn = async (matchId, actions) => {
  const { penaltyTurn } = await import('../../server/penalty-fns')
  const r = (await penaltyTurn({ data: { matchId, actions } })) as PenaltyTurnReply | { error: string }
  if ('error' in r) throw new TurnRefused(r.error)
  return r
}
