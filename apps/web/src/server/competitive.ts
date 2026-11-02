import { sql } from 'drizzle-orm'
import { SEALED_GAMES } from '@duelwise/core/src/sealed'
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

/** Every read that counts a result for anyone's standing adds this: the match was neither left early, played as practice, nor settled as never played. */
export const competitive = sql`${notLeft} and ${notPractice} and ${notUnplayed}`

/** Whether a stored match row was started as practice. */
export function isPractice(flags: unknown): boolean {
  return typeof flags === 'object' && flags !== null && (flags as Record<string, unknown>)[PRACTICE_FLAG] === true
}

/**
 * A sealed turn game (Word keeps its own marks and is left out) whose row never received its setup has no match behind it: nothing was
 * played or revealed, so walking away costs no rating. The settle writes this marker so the rating step can see it after the rewrite.
 */
export const UNPLAYED_FLAG = 'unplayed'

const SEALED_TURN_GAMES = SEALED_GAMES.filter((g) => g !== 'word')

/** Whether a started row of this game has no stored setup yet, so it was never played. */
export function isUnplayed(game: string, flags: unknown): boolean {
  if (!SEALED_TURN_GAMES.some((g) => g === game)) return false
  const log = typeof flags === 'object' && flags !== null ? (flags as Record<string, unknown>).sealedLog : undefined
  const human = typeof log === 'object' && log !== null ? (log as Record<string, unknown>).human : undefined
  return !Array.isArray(human) || human.length === 0
}

const sealedTurnGames = sql.join(SEALED_TURN_GAMES.map((g) => sql`${g}`), sql`, `)

/** The new filterFlags of a row that is being settled by a rewrite (abandoned): the given flags, plus the practice marker the row already had, plus the unplayed marker of a sealed row with no setup. */
export const withPractice = (flags: Record<string, unknown>) =>
  sql`${JSON.stringify(flags)}::jsonb || case when coalesce((${schema.match.filterFlags}->>'practice')::boolean, false) then '{"practice":true}'::jsonb else '{}'::jsonb end || case when ${schema.match.game} in (${sealedTurnGames}) and coalesce(jsonb_array_length(${schema.match.filterFlags}->'sealedLog'->'human'), 0) = 0 then '{"unplayed":true}'::jsonb else '{}'::jsonb end`

/** For RETURNING: whether the row was started as practice. */
export const practiceColumn = sql<boolean>`coalesce((${schema.match.filterFlags}->>'practice')::boolean, false)`

/** For RETURNING after withPractice: whether the row was a sealed match that never got its setup. */
export const unplayedColumn = sql<boolean>`coalesce((${schema.match.filterFlags}->>'unplayed')::boolean, false)`
