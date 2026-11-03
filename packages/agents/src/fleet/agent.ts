import { fleetCore, type FleetObs } from '@duelwise/core/src/games/fleet'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { FLEET_LEVELS } from './levels'
import { placeNext } from './placer'
import { chooseShot } from './shooter'

/**
 * The encoded action for this observation: one ship placement during setup (uniform random valid at every level),
 * then a shot. It reads only the observation, so it plays from what a player sees.
 */
export function chooseFleetAction(level: Level, obs: FleetObs, rng: Rng): number {
  if (obs.phase === 'setup') {
    const p = placeNext(obs.ships, rng)
    return fleetCore.encodeAction({ kind: 'place', cell: p.cell, vertical: p.vertical })
  }
  return fleetCore.encodeAction({ kind: 'shot', cell: chooseShot(FLEET_LEVELS[level], obs, rng) })
}

export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  return {
    preview: false,
    reset(seed) {
      // Mixing in the seat keeps two agents of the same level from drawing the same random numbers.
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1)) | 0)
    },
    async act(obs) {
      return [chooseFleetAction(level, obs as FleetObs, rng)]
    },
    dispose() {},
  }
}
