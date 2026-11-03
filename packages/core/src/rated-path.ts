import type { GameId } from './product'

/**
 * Games with no rated path yet: the server cannot re-run the opponent, so a record's opponent moves could be anything. Every match of one of these
 * is stored as Practice whatever the start asked for, and none gets offline tickets, so no rating, path stop or leaderboard row can rest on a record
 * nothing checks. Crosscurrent leaves this list when it joins the server-checked games with its measured, server-checked rated path.
 */
export const RATED_NOT_OPEN: readonly GameId[] = ['slack']
