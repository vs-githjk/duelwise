import type { GameId, Level } from '@duelwise/core/src/product'

type Entry = { levels?: Partial<Record<Level, { version?: string }>>; champion?: string }

// Registry JSON ships inside the bundle. The try/catch is for plain Bun unit tests, where import.meta.glob does not exist.
let FILES: Record<string, unknown> = {}
try {
  FILES = import.meta.glob('../../../../packages/agents/registry/*.json', { eager: true, import: 'default' }) as Record<string, unknown>
} catch {
  FILES = {}
}

/**
 * The agent version this build serves for a game and level, named the way the server names it (server/matches.ts agentVersionFor):
 * the level's version, else the champion, else "v1". An offline ticket is only used when it was issued for this version.
 */
export function bundleAgentVersion(game: GameId, level: Level): string {
  const entry = Object.entries(FILES).find(([path]) => path.endsWith(`/${game}.json`))?.[1] as Entry | undefined
  return entry?.levels?.[level]?.version ?? entry?.champion ?? 'v1'
}
