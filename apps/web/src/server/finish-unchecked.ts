import type { PgDatabase } from 'drizzle-orm/pg-core'
import type * as schema from '../db/schema'
import { finishMatchHandler, type Caller, type FinishOptions } from './match-handlers'

/**
 * finishMatchHandler with the H1 agent check stubbed to "verified", for tests about everything else (storage, ratings,
 * reports) that play their opponent with random moves. The check itself is tested in agent-check.test.ts and
 * match-handlers.test.ts; production wiring is serverFinishOptions in finish-options.ts.
 */
export function finishUnchecked(db: PgDatabase<any, typeof schema>, input: unknown, who: Caller, opts: FinishOptions = {}) {
  return finishMatchHandler(db, input, who, { verifyAgent: async () => ({ kind: 'verified' }), ...opts })
}
