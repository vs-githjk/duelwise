import { createBot, type BotKind } from '@duelwise/core/src/games/fighter/bots.ts'
import { buildObs } from '@duelwise/core/src/games/fighter/encode.ts'
import { stepPacked } from '@duelwise/core/src/games/fighter/core.ts'
import { FRAME_SKIP, viewDirToScreen } from '@duelwise/core/src/games/fighter/env.ts'
import { N_DIRS } from '@duelwise/core/src/games/fighter/input.ts'
import { cloneState, createState, PHASE, type FighterState } from '@duelwise/core/src/games/fighter/state.ts'

// A deterministic replay for the dev view and the renderer spec: two scripted bots play with the
// env's decision rhythm (one decision every FRAME_SKIP frames), and every frame's state is kept.

export const FIXTURE_FRAMES = 1200

export function buildFixture(seed = 11, frames = FIXTURE_FRAMES, kinds: [BotKind, BotKind] = ['rushdown', 'rushdown']): FighterState[] {
  const s = createState(seed)
  const bots = [createBot(kinds[0], seed * 2 + 1), createBot(kinds[1], seed * 2 + 2)] as const
  const states: FighterState[] = [cloneState(s)]
  let packed: [number, number] = [0, 0]
  while (states.length <= frames && s.matchOver === 0) {
    if (s.phase === PHASE.FIGHT && s.frame % FRAME_SKIP === 0) {
      for (const k of [0, 1] as const) {
        const obs = buildObs(s, k)
        const a = bots[k].act(obs)
        const dir = viewDirToScreen(a % N_DIRS, obs.mirrored)
        packed[k] = a - (a % N_DIRS) + dir
      }
    } else if (s.phase !== PHASE.FIGHT) packed = [0, 0]
    stepPacked(s, packed[0], packed[1])
    states.push(cloneState(s))
  }
  return states
}
