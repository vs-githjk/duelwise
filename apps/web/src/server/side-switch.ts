import type { GameId } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'

/**
 * A test switch for the side the server gives a player: DUELWISE_SIDE=0 or 1 pins every match to that seat, so an e2e server plays
 * the same game every run. Honoured outside production builds only (like DUELWISE_AGENT_CHECK=off in verify-agent.ts); in production
 * it does nothing and the side is always the seed's. Its own file so a test can load it without the vite-only registry glob that matches.ts uses.
 */
export function testSide(env: { DUELWISE_SIDE?: string; NODE_ENV?: string } = process.env): ((game: GameId, seed: number) => Seat) | undefined {
  if (env.NODE_ENV === 'production') return undefined
  if (env.DUELWISE_SIDE === '0') return () => 0
  if (env.DUELWISE_SIDE === '1') return () => 1
  return undefined
}
