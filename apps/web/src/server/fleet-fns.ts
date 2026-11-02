import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import type { FleetObs } from '@duelwise/core/src/games/fleet'
import { callerFromRequest } from './caller'
import { getServerDb } from './server-db'
import { FLEET_SPEC, sealedTurnHandler } from './sealed-duel'

/** One turn of a counted Stormglass match: the player's actions so far in, the player's own view out; the enemy fleet never leaves the server before the end. */
export const fleetTurn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }) => {
    const { db } = await getServerDb()
    const who = await callerFromRequest()
    const r = await sealedTurnHandler(db, data, who, FLEET_SPEC)
    setResponseStatus(r.status)
    // The page reads the view as a FleetObs; the shared body type keeps it `unknown` so one handler serves every sealed game.
    return r.body as { error: string } | { view: FleetObs; over: boolean; reveal?: { seed: number; agentActions: number[] } }
  })
