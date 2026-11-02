import { slackCore } from '@duelwise/core/src/games/slack/core'
import { makeRng } from '@duelwise/core/src/rng'

export const OPENING_PLIES = 4

/**
 * A Slackwater core whose start position is 4 seeded random plies in, so deterministic agents do not replay one game.
 * The rules hold no randomness, so without this the measured games would repeat. Seeds 2k and 2k+1 share an opening:
 * the pair of colour-swapped games. Copied from createOpeningCore in measure/chess.ts. Measurement only, never shipped.
 */
export function createSlackOpeningCore(): typeof slackCore {
  return {
    ...slackCore,
    init(seed) {
      for (let attempt = 0; ; attempt++) {
        const rng = makeRng(Math.floor(seed / 2) * 131 + attempt)
        let s = slackCore.init(seed)
        for (let i = 0; i < OPENING_PLIES && !slackCore.terminal(s); i++) {
          const seat = slackCore.toAct(s)[0]!
          const legal = slackCore.legal(s, seat)
          const m = legal[rng.int(legal.length)]!
          s = slackCore.step(s, seat === 0 ? [m, null] : [null, m])
        }
        if (!slackCore.terminal(s)) return s
      }
    },
  }
}
