import type { GameId } from '@duelwise/core/src/product'

/**
 * The realtime games the relay can carry as rollback matches (apps/duel-relay REALTIME_GAMES). A link for one can be minted (server) and
 * opened (/f/<code>?g=<game>), but no setup screen lists it yet (CHALLENGE_GAMES is what the screens list), so nothing user-facing
 * changes until the realtime pages land. Its own module, so the landing page's chunks do not move.
 */
export const REALTIME_CHALLENGE_GAMES = ['fighter', 'arena', 'puck'] as const satisfies readonly GameId[]
