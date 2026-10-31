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
