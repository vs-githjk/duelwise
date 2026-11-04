import type { GameId } from './product'
import type { Seat } from './types'

/**
 * Games where each match gives the player a random side: chess colour (seat 0 is White), and who moves first in Four in a Row and Crosscurrent
 * (seat 0 moves first). Stormglass, Hold'em, Word Duel and the real-time games keep the player in seat 0.
 */
export const RANDOM_SIDE_GAMES: readonly GameId[] = ['chess', 'four', 'slack']

export function hasRandomSide(game: GameId): boolean {
  return RANDOM_SIDE_GAMES.includes(game)
}

/** The key in a match row's filterFlags that holds the side the server gave the player. Absent means seat 0, so every row made before sides existed replays as it did. */
export const HUMAN_SEAT_FLAG = 'humanSeat'

/**
 * The player's side for a seed. A counted match takes its seed from the server, so the side is the server's choice and a reload or a new tab
 * cannot fish for one without starting a new match. A fixed test seed (?seed) and an unrated local seed use the same rule, so a test can force a side.
 */
export function sideForSeed(game: GameId, seed: number): Seat {
  if (!hasRandomSide(game)) return 0
  // A 32-bit finaliser (murmur3 style) over the low and high words, so neighbouring seeds do not alternate in step.
  let x = (seed >>> 0) ^ (Math.floor(seed / 4294967296) >>> 0) ^ 0x5bd1e995
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  x ^= x >>> 16
  return ((x >>> 0) & 1) as Seat
}

/** The seat a stored match row gave the player: the flag when it is 1, otherwise 0. */
export function assignedSeat(flags: unknown): Seat {
  if (typeof flags !== 'object' || flags === null) return 0
  return (flags as Record<string, unknown>)[HUMAN_SEAT_FLAG] === 1 ? 1 : 0
}
