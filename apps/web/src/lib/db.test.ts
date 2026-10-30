import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { chooseDriver, getDb, resetDbForTests } from './db'

describe('chooseDriver', () => {
  test('DATABASE_URL selects Neon, even under test', () => {
    expect(chooseDriver({ DATABASE_URL: 'postgres://u:p@host/db', NODE_ENV: 'test' })).toBe('neon')
    expect(chooseDriver({ DATABASE_URL: 'postgres://u:p@host/db' })).toBe('neon')
  })

  test('test runs use an in-memory PGlite', () => {
    expect(chooseDriver({ NODE_ENV: 'test' })).toBe('pglite-memory')
  })

  test('DUELWISE_DB=memory forces the in-memory store even in development', () => {
    expect(chooseDriver({ DUELWISE_DB: 'memory', NODE_ENV: 'development' })).toBe('pglite-memory')
    expect(chooseDriver({ DUELWISE_DB: 'memory', DATABASE_URL: 'postgres://u:p@h/d' })).toBe('neon')
  })

  test('development uses the PGlite file store', () => {
    expect(chooseDriver({})).toBe('pglite-file')
    expect(chooseDriver({ NODE_ENV: 'development' })).toBe('pglite-file')
  })

  test('an empty DATABASE_URL counts as unset', () => {
    expect(chooseDriver({ DATABASE_URL: '', NODE_ENV: 'test' })).toBe('pglite-memory')
  })
})

describe('getDb', () => {
  test('returns a working in-memory database under test and reuses it', async () => {
    resetDbForTests()
    const { db, driver } = await getDb({ NODE_ENV: 'test' })
    expect(driver).toBe('pglite-memory')
    const res = await db.execute(sql`select 1 as one`)
    expect(res.rows[0]).toEqual({ one: 1 })
    expect((await getDb({ NODE_ENV: 'test' })).db).toBe(db)
    resetDbForTests()
  })
})
