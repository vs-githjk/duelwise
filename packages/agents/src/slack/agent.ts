import type { SlackObs } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { chooseSlackAction } from './levels'

/** Crosscurrent agent: search only, no model file, so it is never a stub. The seat is mixed into the seed so two seats on one seed draw different noise. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  let seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  return {
    preview: false,
    reset(seed, forSeat) {
      if (forSeat !== undefined) seat = forSeat
      rng = makeRng((seed + 104729 * (seat + 1)) >>> 0)
    },
    async act(obs) {
      return [chooseSlackAction(level, obs as SlackObs, rng)]
    },
    dispose() {},
  }
}
