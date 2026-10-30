import { migrateDb } from '../db/migrate'
import { getDb, type DbHandle } from '../lib/db'
import type * as schema from '../db/schema'
import type { PgDatabase } from 'drizzle-orm/pg-core'

let ready: Promise<DbHandle & { db: PgDatabase<any, typeof schema> }> | null = null

/**
 * The app database with migrations applied. PGlite (local dev, tests) is migrated on first use;
 * Neon is migrated by hand with the SQL in apps/web/drizzle, never from running code.
 */
export function getServerDb() {
  ready ??= getDb().then(async (h) => {
    if (h.driver !== 'neon') await migrateDb(h.db as never)
    return h as DbHandle & { db: PgDatabase<any, typeof schema> }
  })
  return ready
}
