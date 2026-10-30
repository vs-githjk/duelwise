import { createBot, type BotKind } from '@duelwise/core/src/games/arena/bots.ts'
import { stepPacked, createState } from '@duelwise/core/src/games/arena/core.ts'
import { buildObs } from '@duelwise/core/src/games/arena/encode.ts'
import { packInput } from '@duelwise/core/src/games/arena/input.ts'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons.ts'
import { cloneState, type ArenaState } from '@duelwise/core/src/games/arena/state.ts'

// A deterministic replay for the dev view and the render spec: two scripted bots play with the env's
// decision rhythm (one decision every 4 frames, held between), and every frame's state is kept.

export const FIXTURE_FRAMES = 1500
const FRAME_SKIP = 4

export function buildFixture(seed = 6, frames = FIXTURE_FRAMES, kinds: [BotKind, BotKind] = ['rusher', 'random'], guns?: [number, number]): ArenaState[] {
  const s = createState(seed, { buyFrames: 80, roundFrames: 1200 })
  // `guns` hands each seat a weapon (and a full magazine) from the start, so a replay can show the rifles.
  if (guns) {
    for (const k of [0, 1] as const) {
      s.players[k].weapon = guns[k]
      s.players[k].ammo = WEAPONS[guns[k]]!.magazine
    }
  }
  const bots = [createBot(kinds[0], seed * 2 + 1), createBot(kinds[1], seed * 2 + 2)] as const
  const states: ArenaState[] = [cloneState(s)]
  const packed: [number, number] = [0, 0]
  while (states.length <= frames && s.matchOver === 0) {
    if (s.frame % FRAME_SKIP === 0) {
      for (const k of [0, 1] as const) packed[k] = packInput(bots[k].act(buildObs(s, k)))
    }
    stepPacked(s, packed[0], packed[1])
    states.push(cloneState(s))
  }
  return states
}
