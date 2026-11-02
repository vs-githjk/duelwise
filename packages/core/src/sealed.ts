import type { GameId } from './product'

/** Games whose seed never leaves the server while a match runs. Fleet and Bingo join this list when they are promoted. */
export const SEALED_GAMES: readonly GameId[] = ['word']

export const isSealed = (g: GameId): boolean => SEALED_GAMES.includes(g)
