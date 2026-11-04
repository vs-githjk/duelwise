import type { GameId } from './product'

/**
 * Games whose seed never leaves the server while a match runs. A turn game keeps its log in sealed-log.ts. Twelve Yards is on it because a kick's roll and the
 * opponent's pick both come from the seed: a page that held the seed could read them before choosing.
 */
export const SEALED_GAMES: readonly GameId[] = ['word', 'fleet', 'penalty']

export const isSealed = (g: GameId): boolean => SEALED_GAMES.includes(g)
