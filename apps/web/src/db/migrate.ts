import { join } from 'node:path'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

/** The SQL files drizzle-kit generated; apps/web/drizzle. */
export const MIGRATIONS_FOLDER = join(import.meta.dirname, '..', '..', 'drizzle')

/**
 * Applies every migration in apps/web/drizzle to a PGlite database (idempotent: applied ones are
 * skipped). drizzle-kit only generates the SQL; this small step runs it, because drizzle-kit's
 * own `migrate` does not target PGlite. Neon is migrated by hand, never from here.
 */
export async function migrateDb(db: PgliteDatabase<any>, folder: string = MIGRATIONS_FOLDER): Promise<void> {
  await migrate(db, { migrationsFolder: folder })
}
