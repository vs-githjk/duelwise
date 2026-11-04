import type { GameId } from './product'

/** Games whose seed never leaves the server while a match runs. Fleet and Bingo join this list when they are promoted (a turn game keeps its log in sealed-log.ts). */
export const SEALED_GAMES: readonly GameId[] = ['word', 'fleet']

export const isSealed = (g: GameId): boolean => SEALED_GAMES.includes(g)
