import type { FleetObs } from '@duelwise/core/src/games/fleet'

/** One answer of the server for a counted Stormglass match: the player's own view, and the seed and the opponent's actions only once it is over. */
export interface FleetTurnReply {
  view: FleetObs
  over: boolean
  reveal?: { seed: number; agentActions: number[] }
}

/** Sends every action I have taken so far (the five setup placements, then one shot more each turn); the server plays the opponent and answers with my view. A retried request gets the same answer. */
export type FetchTurn = (matchId: string, actions: number[]) => Promise<FleetTurnReply>

/** The server answered with { error }: a final refusal (the match is settled, over its cap, not yours). Repeating the request cannot help, unlike a network failure. */
export class TurnRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TurnRefused'
  }
}

/** The real call: the server function, loaded on first use so this file stays free of server code. */
export const serverFetchTurn: FetchTurn = async (matchId, actions) => {
  const { fleetTurn } = await import('../../server/fleet-fns')
  const r = (await fleetTurn({ data: { matchId, actions } })) as FleetTurnReply | { error: string }
  if ('error' in r) throw new TurnRefused(r.error)
  return r
}
