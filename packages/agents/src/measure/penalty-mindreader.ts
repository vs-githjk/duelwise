import { GOAL_PER_MILLE, type PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { createProxyAgent } from './penalty-people'
import type { Proxy } from './people'

// A7: the luck ceiling of Twelve Yards against one test player. A mind reader is told the test player's next pick before it chooses (it runs a copy of the
// test player on the mirrored observation with the same seed) and plays the best answer to it. No honest agent can beat what it scores against that player,
// because an honest agent only has the kicks so far. It is a measurement script, never an opponent and never imported by the site. The level name picks
// the test player (easy = beginner, medium = average, hard = strong), the same way penalty-people's panel module does.
const LEVEL_PROXY: Record<string, Proxy> = { easy: 'beginner', medium: 'average', hard: 'strong' }

function mirrored(o: PenaltyObs): PenaltyObs {
  return {
    ...o,
    seat: (1 - o.seat) as Seat,
    role: o.role === null ? null : o.role === 'shooter' ? 'keeper' : 'shooter',
    goals: [o.goals[1], o.goals[0]],
    taken: [o.taken[1], o.taken[0]],
    kicks: o.kicks.map((k) => ({ ...k, byMe: !k.byMe })),
  }
}

export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const proxy = LEVEL_PROXY[level]
  if (!proxy) throw new Error(`penalty mind reader: no test player for level ${level}`)
  const seat = (opts.seat ?? 1) as Seat
  const twin = createProxyAgent(proxy, { seat: (1 - seat) as Seat })
  return {
    preview: false,
    reset(seed, forSeat) {
      twin.reset(seed, forSeat === undefined ? (1 - seat) as Seat : ((1 - forSeat) as Seat))
    },
    async act(obs, state) {
      const o = obs as PenaltyObs
      const theirs = (await twin.act(mirrored(o), state))[0]!
      if (o.role === 'shooter') {
        let best = 0
        for (let z = 1; z < 9; z++) if (GOAL_PER_MILLE[z]![theirs]! > GOAL_PER_MILLE[best]![theirs]!) best = z
        return [best]
      }
      let best = 0
      for (let d = 1; d < 5; d++) if (GOAL_PER_MILLE[theirs]![d]! < GOAL_PER_MILLE[theirs]![best]!) best = d
      return [best]
    },
    dispose() {
      twin.dispose()
    },
  }
}
