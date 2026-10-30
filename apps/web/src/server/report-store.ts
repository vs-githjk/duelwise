import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'

type Db = PgDatabase<any, typeof schema>

export interface RatingChange {
  before: number
  after: number
  provisional: boolean
}

/** Remembers the rating change of a match so its report can show it later. Safe to call twice. */
export async function saveRatingChange(db: Db, matchId: string, change: RatingChange): Promise<void> {
  try {
    await db
      .insert(schema.matchReport)
      .values({ matchId, eloBefore: change.before, eloAfter: change.after, provisional: change.provisional })
      .onConflictDoUpdate({ target: schema.matchReport.matchId, set: { eloBefore: change.before, eloAfter: change.after, provisional: change.provisional } })
  } catch (e) {
    // The report is a convenience; a failure here must never fail the match it describes.
    console.error('report rating save failed', e instanceof Error ? e.message : e)
  }
}
