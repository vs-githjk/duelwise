import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { WordObs } from '@duelwise/core/src/games/word/core'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { chooseGuess } from './solver'

/**
 * Word Duel agent: a solver level (see solver.ts). It reads only the observation, so it plays from what a
 * player sees. Returns the guess as an ALLOWED index, the core's encoded action.
 */
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
      return [chooseGuess(level, obs as WordObs, rng)]
    },
    dispose() {},
  }
}
