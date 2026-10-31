import { sql } from 'drizzle-orm'
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

/** Every read that counts a result for anyone's standing adds this: the match was neither left early nor played as practice. */
export const competitive = sql`${notLeft} and ${notPractice}`

/** Whether a stored match row was started as practice. */
export function isPractice(flags: unknown): boolean {
  return typeof flags === 'object' && flags !== null && (flags as Record<string, unknown>)[PRACTICE_FLAG] === true
}

/** The new filterFlags of a row that is being settled by a rewrite (abandoned): the given flags, plus the practice marker the row already had. */
export const withPractice = (flags: Record<string, unknown>) =>
  sql`${JSON.stringify(flags)}::jsonb || case when coalesce((${schema.match.filterFlags}->>'practice')::boolean, false) then '{"practice":true}'::jsonb else '{}'::jsonb end`

/** For RETURNING: whether the row was started as practice. */
export const practiceColumn = sql<boolean>`coalesce((${schema.match.filterFlags}->>'practice')::boolean, false)`
