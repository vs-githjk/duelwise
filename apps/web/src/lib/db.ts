import type { PGlite } from '@electric-sql/pglite'

export type DbDriver = 'neon' | 'pglite-file' | 'pglite-memory'

export interface DbEnv {
  DATABASE_URL?: string
  NODE_ENV?: string
  /** 'memory' forces a throwaway in-memory PGlite (the Playwright server sets it). */
  DUELWISE_DB?: string
}

/** Neon when DATABASE_URL is set, in-memory PGlite under test or DUELWISE_DB=memory, otherwise the PGlite file in the common root. */
export function chooseDriver(env: DbEnv): DbDriver {
  if (env.DATABASE_URL) return 'neon'
  if (env.NODE_ENV === 'test' || env.DUELWISE_DB === 'memory') return 'pglite-memory'
  return 'pglite-file'
}

/** The main checkout, even from a worktree: the parent of `git rev-parse --git-common-dir`. */
async function commonRoot(): Promise<string> {
  const { execFileSync } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  return resolve(gitDir, '..')
}

// Drizzle's three drivers share the query surface this app uses.
type AnyDb = import('drizzle-orm/pglite').PgliteDatabase<typeof import('../db/schema')>

export interface DbHandle {
  db: AnyDb
  driver: DbDriver
}

let cached: Promise<DbHandle> | null = null
let closer: (() => Promise<void>) | null = null

/** Server-only. One handle per process. `.data/pglite` is the local dev database; tests never touch it. */
export function getDb(env: DbEnv = process.env): Promise<DbHandle> {
  cached ??= open(env)
  return cached
}

async function open(env: DbEnv): Promise<DbHandle> {
  const driver = chooseDriver(env)
  if (driver === 'neon') {
    const { neon } = await import('@neondatabase/serverless')
    const { drizzle } = await import('drizzle-orm/neon-http')
    return { db: drizzle(neon(env.DATABASE_URL!)) as unknown as AnyDb, driver }
  }
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  let client: PGlite
  if (driver === 'pglite-memory') {
    client = new PGlite()
  } else {
    const { join } = await import('node:path')
    const { mkdir } = await import('node:fs/promises')
    const dir = join(await commonRoot(), '.data', 'pglite')
    await mkdir(dir, { recursive: true })
    client = new PGlite(dir)
  }
  await client.waitReady
  closer = () => client.close()
  return { db: drizzle(client) as AnyDb, driver }
}

/** Test helper: closes and forgets the handle. */
export function resetDbForTests(): void {
  const c = closer
  cached = null
  closer = null
  void c?.()
}
