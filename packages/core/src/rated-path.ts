import type { GameId } from './product'

/**
 * Games with no rated path yet: the server cannot re-run the opponent, so a record's opponent moves could be anything. Every match of one of these
 * is stored as Practice whatever the start asked for, and none gets offline tickets, so no rating, path stop or leaderboard row can rest on a record
 * nothing checks. Crosscurrent left it when its opponent joined the server-checked games (apps/web/src/server/agent-check.ts); Twelve Yards is on it
 * until its measured registry and its server check land (promotion part 2), and a new game that is not server-checked joins it until it is.
 * A test pins both the list and the guard that reads it.
 */
export const RATED_NOT_OPEN: readonly GameId[] = ['penalty']

/**
 * Games kept out of offline tickets although they are rated. A ticket lets a player play without the server and upload only the matches they won,
 * and the owner's rule is that offline matches are unrated (decisions.md, Nov 3 16:23), so these games are rated only with a connection, like Stormglass:
 * offline they play a local match that counts nowhere. For the games with random sides (chess, Four, Crosscurrent) a ticket would also show its side
 * before it is played, so a script could keep only the sides it likes. A ticket issued before this rule is never handed out again by the page
 * (lib/tickets.ts), expires unused at no cost, and one already played still settles as issued.
 */
export const NO_OFFLINE_TICKETS: readonly GameId[] = ['slack', 'penalty', 'chess', 'four', 'holdem', 'fighter', 'arena']
