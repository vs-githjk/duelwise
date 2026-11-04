import { sql } from 'drizzle-orm'
import { SEALED_GAMES } from '@duelwise/core/src/sealed'
import type { GameId } from '@duelwise/core/src/product'
import * as schema from '../db/schema'

/**
 * A match the player left before its chosen end is stored as finished and valid (it is a real result on the chips so far, and it may
 * be trained on), but it is marked with this flag and never counts as a win, a loss or a clear anywhere competitive: the leaderboard,
 * the adventure path, the record against a level, the profile and the weekly human win rate. Owner stats and the training funnel still
 * see it as played. Reads that must leave it out add `notLeft`.
 */
export const LEFT_FLAG = 'leftTable'

export const notLeft = sql`coalesce((${schema.match.filterFlags}->>'leftTable')::boolean, false) = false`

/**
 * A practice match is the same game, played unrated (the player picked Practice on the setup screen). The server writes this flag when
 * the match starts, from the start request only; nothing a finish upload says can add or remove it. Like a left match it is stored as
 * finished and valid and may be trained on, but no competitive read counts it: no rating, no leaderboard or beat count, no adventure
 * path clear, no profile record, no landing tally, no weekly win rate. Owner stats and the training funnel still see it as played.
 */
export const PRACTICE_FLAG = 'practice'

export const notPractice = sql`coalesce((${schema.match.filterFlags}->>'practice')::boolean, false) = false`

export const notUnplayed = sql`coalesce((${schema.match.filterFlags}->>'unplayed')::boolean, false) = false`

/**
 * A sealed turn match the server's own log says the player won, settled by giving up (resign, abandon sweep, over-cap sweep) before the
 * win was uploaded: the player may or may not have seen the end. Only a resigned or abandoned row is left out; a win that was uploaded and finished keeps counting. The player won, so it moves no rating either way, and it is not a loss on any record. The turn handler writes the
 * marker with the terminal log; resign derives it from the log itself.
 */
export const LOGGED_WIN_FLAG = 'loggedWin'

export const notLoggedWin = sql`not (${schema.match.status} in ('resigned', 'abandoned') and coalesce((${schema.match.filterFlags}->>'loggedWin')::boolean, false))`

/** Every read that counts a result for anyone's standing adds this: the match was neither left early, played as practice, settled as never played, nor given up after the log already said the player won. */
export const competitive = sql`${notLeft} and ${notPractice} and ${notUnplayed} and ${notLoggedWin}`

/** Whether a stored match row was started as practice. */
export function isPractice(flags: unknown): boolean {
  return typeof flags === 'object' && flags !== null && (flags as Record<string, unknown>)[PRACTICE_FLAG] === true
}

/**
 * A sealed turn game (Word keeps its own marks and is left out) whose row never received a shot (no setup, or the setup alone) has no match behind it: nothing was
 * played or revealed, so walking away costs no rating. The settle writes this marker so the rating step can see it after the rewrite.
 */
export const UNPLAYED_FLAG = 'unplayed'

const SEALED_TURN_GAMES = SEALED_GAMES.filter((g) => g !== 'word')

/**
 * The sealed turn games whose setup request reveals nothing, so a row that holds no more than that many player actions was never played and walking away costs
 * no rating. Stormglass: its five placements. Twelve Yards is not here: its first request is already a kick whose answer shows the opponent's pick, and a free
 * exit before it would let a script start matches until it is given the side it likes, so a Twelve Yards match left at any point is charged like chess.
 */
const UNPLAYED_UP_TO: Partial<Record<GameId, number>> = { fleet: 5 }

/**
 * How many actions a sealed turn game's setup request carries (FLEET_SPEC.setupTicks, pinned equal by a test). A row whose stored player list is no
 * longer than this has revealed nothing: the setup reply holds only the player's own fleet, so a lost reply must not cost a rating loss.
 */
export const SEALED_SETUP_TICKS = UNPLAYED_UP_TO.fleet!

/** How many of the player's actions a row's sealed log holds; 0 for a row with no log. */
export function sealedLogLength(flags: unknown): number {
  const log = typeof flags === 'object' && flags !== null ? (flags as Record<string, unknown>).sealedLog : undefined
  const human = typeof log === 'object' && log !== null ? (log as Record<string, unknown>).human : undefined
  return Array.isArray(human) ? human.length : 0
}

/** For a settling write: the stored log is still the one the decision read, so a shot landing between the read and the write stops the write. */
export const sealedLogStill = (flags: unknown) => sql`coalesce(jsonb_array_length(${schema.match.filterFlags}->'sealedLog'->'human'), 0) = ${sealedLogLength(flags)}`

/** Whether a started row of this game has no stored shot yet (no setup, or the setup only), so it was never played. */
export function isUnplayed(game: string, flags: unknown): boolean {
  const upTo = UNPLAYED_UP_TO[game as GameId]
  return upTo !== undefined && sealedLogLength(flags) <= upTo
}

const unplayedGames = sql.join(Object.keys(UNPLAYED_UP_TO).map((g) => sql`${g}`), sql`, `)
const sealedTurnGames = sql.join(SEALED_TURN_GAMES.map((g) => sql`${g}`), sql`, `)

/**
 * What a settling rewrite keeps of a sealed turn row's own flags: the hidden setup and shots (`sealedLog`, server only, kept so a later
 * per-player memory can read them) and the logged-win marker. Other games carry nothing, so their flags are unchanged.
 */
export function keptSealedFlags(game: string, flags: unknown): Record<string, unknown> {
  if (!SEALED_TURN_GAMES.some((g) => g === game) || typeof flags !== 'object' || flags === null) return {}
  const f = flags as Record<string, unknown>
  return { ...(f.sealedLog !== undefined ? { sealedLog: f.sealedLog } : {}), ...(f[LOGGED_WIN_FLAG] === true ? { [LOGGED_WIN_FLAG]: true } : {}) }
}

/** The new filterFlags of a row that is being settled by a rewrite (abandoned): the given flags, plus the practice marker the row already had, plus the unplayed marker of a sealed row with no setup, plus what keptSealedFlags keeps. */
export const withPractice = (flags: Record<string, unknown>) =>
  sql`${JSON.stringify(flags)}::jsonb || case when coalesce((${schema.match.filterFlags}->>'practice')::boolean, false) then '{"practice":true}'::jsonb else '{}'::jsonb end || case when ${schema.match.game} in (${unplayedGames}) and coalesce(jsonb_array_length(${schema.match.filterFlags}->'sealedLog'->'human'), 0) <= ${SEALED_SETUP_TICKS} then '{"unplayed":true}'::jsonb else '{}'::jsonb end || case when ${schema.match.game} in (${sealedTurnGames}) and ${schema.match.filterFlags}->'sealedLog' is not null then jsonb_build_object('sealedLog', ${schema.match.filterFlags}->'sealedLog') else '{}'::jsonb end || case when ${schema.match.game} in (${sealedTurnGames}) and coalesce((${schema.match.filterFlags}->>'loggedWin')::boolean, false) then '{"loggedWin":true}'::jsonb else '{}'::jsonb end`

/** For RETURNING: whether the row was started as practice. */
export const practiceColumn = sql<boolean>`coalesce((${schema.match.filterFlags}->>'practice')::boolean, false)`

/** For RETURNING after withPractice: whether the row was a sealed match that never got its setup. */
export const unplayedColumn = sql<boolean>`coalesce((${schema.match.filterFlags}->>'unplayed')::boolean, false)`

/** For RETURNING after withPractice: whether the row was a sealed match the log said the player won. */
export const loggedWinColumn = sql<boolean>`coalesce((${schema.match.filterFlags}->>'loggedWin')::boolean, false)`
