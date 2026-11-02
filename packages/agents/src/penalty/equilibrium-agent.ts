import type { PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { EQ_KEEPER, EQ_SHOOTER } from './levels'

/**
 * A player who truly mixes: every kick and dive is drawn from the equilibrium mix of the goal table, whatever happened before.
 * It exists for the dry ladder's claim C5 row (Sable v an equilibrium player) and is not a game level.
 */
export async function createGameAgent(_level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  return {
    preview: true,
    reset(seed) {
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x2545f491)) | 0)
    },
    async act(obs) {
      const o = obs as PenaltyObs
      const d = o.role === 'shooter' ? EQ_SHOOTER : EQ_KEEPER
      let r = rng.float()
      for (let i = 0; i < 3; i++) {
        r -= d[i]!
        if (r < 0) return [i]
      }
      return [2]
    },
    dispose() {},
  }
}
