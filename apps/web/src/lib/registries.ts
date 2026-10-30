import { visibleRegistry } from './strength-gates'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { validateRegistry, type Registry } from '@duelwise/agents/src/registry'

// Registry JSON ships inside the bundle, the same way the agents pages read it.
const FILES = import.meta.glob('../../../../packages/agents/registry/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

/** The game's agent registry, or null when it has none yet or it does not validate. */
export function registryFor(game: GameId): Registry | null {
  const raw = Object.entries(FILES).find(([path]) => path.endsWith(`/${game}.json`))?.[1]
  return raw && validateRegistry(raw).ok ? visibleRegistry(raw as Registry) : null
}

/** Every game's registry (null where none validates), for copy that names the games that train. */
export function allRegistries(): Record<GameId, Registry | null> {
  return Object.fromEntries((Object.keys(PRODUCT.games) as GameId[]).map((g) => [g, registryFor(g)])) as Record<GameId, Registry | null>
}
