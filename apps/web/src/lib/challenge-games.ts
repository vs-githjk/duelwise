import type { GameId } from '@duelwise/core/src/product'

/** The games the relay can carry (apps/duel-relay RELAY_GAMES). Kept in its own small module so client code never pulls in the server minting code. */
export const CHALLENGE_GAMES = ['chess', 'four', 'slack', 'penalty', 'fleet', 'word', 'holdem'] as const satisfies readonly GameId[]
