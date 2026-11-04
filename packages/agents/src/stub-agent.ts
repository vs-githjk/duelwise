import { getCore } from '@duelwise/core/src/games/index'
import type { GameId, Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from './agent-types'

/**
 * Preview agent shared by every per-game stub: plays a random legal action. Owners replace
 * their game's agent.ts, not this file. Realtime cores list no legal actions, so the stub
 * returns the neutral action [0].
 */
export function createStubAgent(game: GameId, _level: Level, opts: AgentOpts = {}): PreviewAgent {
  let seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  return {
    preview: true,
    reset(seed, forSeat) {
      if (forSeat !== undefined) seat = forSeat
      rng = makeRng(seed)
    },
    async act(_obs, state) {
      const core = opts.core ?? getCore(game)
      const legal = core.legal(state, seat)
      if (legal.length === 0) return [0]
      return [core.encodeAction(legal[rng.int(legal.length)])]
    },
    dispose() {},
  }
}
