import type { GameId, Level } from '@duelwise/core/src/product'
import type { AgentOpts, PreviewAgent } from './agent-types'

type Factory = (level: Level, opts?: AgentOpts) => Promise<PreviewAgent>

// Lazy imports keep each game's agent (and its model code) out of bundles that do not play it.
const FACTORIES: Record<GameId, () => Promise<{ createGameAgent: Factory }>> = {
  chess: () => import('./chess/agent'),
  four: () => import('./four/agent'),
  holdem: () => import('./holdem/agent'),
  word: () => import('./word/agent'),
  fighter: () => import('./fighter/agent'),
  arena: () => import('./arena/agent'),
  fleet: () => import('./fleet/agent'),
  slack: () => import('./slack/agent'),
}

export async function createGameAgent(game: GameId, level: Level, opts?: AgentOpts): Promise<PreviewAgent> {
  const mod = await FACTORIES[game]()
  return mod.createGameAgent(level, opts)
}
