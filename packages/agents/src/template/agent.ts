import { cairnCore, optimalTake, type CairnObservation } from '@duelwise/core/src/games/template/cairn'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'

/**
 * Cairn agent: the template for a scripted (no neural net) agent. Each level plays the perfect
 * move with a fixed chance and a random legal move otherwise, so the levels differ only by that
 * number. The same numbers go in the level config of the registry file when the game is published.
 */
export const CAIRN_LEVELS: Record<Level, { perfectShare: number }> = {
  easy: { perfectShare: 0 },
  medium: { perfectShare: 0.5 },
  hard: { perfectShare: 0.9 },
  champion: { perfectShare: 1 },
}

/** Matches the factory signature in agent-dispatch.ts: (level, opts) => Promise<PreviewAgent>. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  const { perfectShare } = CAIRN_LEVELS[level]
  let rng: Rng = makeRng(0)
  return {
    // false: this agent is final, not a stand-in for one that is still being trained.
    preview: false,
    reset(seed) {
      // Mixing in the seat keeps two agents of the same level from drawing the same random numbers.
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1)) | 0)
    },
    async act(obs) {
      // Read only the observation: the agent plays from what a player sees.
      const { pile } = obs as CairnObservation
      const legalMax = Math.min(3, pile)
      const take = rng.float() < perfectShare ? Math.min(optimalTake(pile), legalMax) : 1 + rng.int(legalMax)
      return [cairnCore.encodeAction(take)]
    },
    dispose() {},
  }
}
