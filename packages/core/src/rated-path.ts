import type { GameId } from './product'

/**
 * Games with no rated path yet: the server cannot re-run the opponent, so a record's opponent moves could be anything. Every match of one of these
 * is stored as Practice whatever the start asked for, and none gets offline tickets, so no rating, path stop or leaderboard row can rest on a record
 * nothing checks. The list is empty: Crosscurrent left it when its opponent joined the server-checked games (apps/web/src/server/agent-check.ts),
 * and a new game that is not server-checked joins it until it is. A test pins both the empty list and the guard that reads it.
 */
export const RATED_NOT_OPEN: readonly GameId[] = []
