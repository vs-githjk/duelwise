import { GRID, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { createBot, type PuckBotKind } from '@duelwise/core/src/games/puck/bots'
import { observe } from '@duelwise/core/src/games/puck/core'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import type { PuckState } from '@duelwise/core/src/games/puck/state'
import type { Seat } from '@duelwise/core/src/types'

// Dev builds only (the page imports this behind import.meta.env.DEV, so it is not in a production chunk): a scripted hand for the two-browser
// test, picked with ?bot=<kind>. It plays this device's own seat in its own view, every second tick, like the solo test hand.

const KINDS: readonly PuckBotKind[] = ['random', 'striker', 'goalie', 'banker', 'shadow', 'pip', 'mouse']

export function makeDevBot(kind: string, seat: Seat, seed: number): ((s: PuckState, tick: number) => number) | null {
  if (!(KINDS as readonly string[]).includes(kind)) return null
  const bot = createBot(kind as PuckBotKind, seed)
  return (s, tick) => {
    if (tick % 2 !== 0) return NO_INPUT
    const t = bot.act(observe(s, seat))
    return unitToCell(t[0]) + GRID * unitToCell(t[1])
  }
}
