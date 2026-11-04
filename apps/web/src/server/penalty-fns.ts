import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import type { PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import { callerFromRequest } from './caller'
import { getServerDb } from './server-db'
import { PENALTY_SPEC, sealedTurnHandler } from './sealed-duel'

/** One kick of a counted Twelve Yards match: the player's picks so far in, the player's own view out; the opponent's pick for a kick leaves the server only after the player's pick for it is stored. */
export const penaltyTurn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }) => {
    const { db } = await getServerDb()
    const who = await callerFromRequest()
    const r = await sealedTurnHandler(db, data, who, PENALTY_SPEC)
    setResponseStatus(r.status)
    // The page reads the view as a PenaltyObs; the shared body type keeps it `unknown` so one handler serves every sealed game.
    return r.body as { error: string } | { view: PenaltyObs; over: boolean; reveal?: { seed: number; agentActions: number[]; entropy?: number[] } }
  })
