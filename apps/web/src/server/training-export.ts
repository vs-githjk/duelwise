import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { GameId } from '@duelwise/core/src/product'
import * as schema from '../db/schema'

type Db = PgDatabase<any, typeof schema>

/**
 * The matches that may feed training: finished, replay-verified, from players who allow it, and not
 * a resignation. Resigned and abandoned matches have another status and never qualify; the
 * resigned flag is checked as well so a row that somehow keeps status 'finished' still stays out.
 */
export async function listTrainingMatches(db: Db, game: GameId) {
  return db
    .select({ id: schema.match.id, level: schema.match.level, agentVersion: schema.match.agentVersion, record: schema.match.record })
    .from(schema.match)
    .where(
      and(
        eq(schema.match.game, game),
        eq(schema.match.status, 'finished'),
        eq(schema.match.recordValid, true),
        eq(schema.match.trainingAllowed, true),
        or(isNull(schema.match.filterFlags), sql`coalesce(${schema.match.filterFlags}->>'resigned', 'false') <> 'true'`),
      ),
    )
    .orderBy(asc(schema.match.startedAt), asc(schema.match.id))
}
