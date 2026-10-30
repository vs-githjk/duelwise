import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { authConfig, buildAuthOptions, createAuth, devLoginEnabled, DEV_PASSWORD, devEmail } from './auth'

const GOOGLE = { GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }
const GITHUB = { GITHUB_CLIENT_ID: 'h-id', GITHUB_CLIENT_SECRET: 'h-secret' }

describe('devLoginEnabled', () => {
  test('only with DEV_LOGIN=1 and NODE_ENV not production', () => {
    expect(devLoginEnabled({ DEV_LOGIN: '1', NODE_ENV: 'development' })).toBe(true)
    expect(devLoginEnabled({ DEV_LOGIN: '1' })).toBe(true)
    expect(devLoginEnabled({ DEV_LOGIN: '1', NODE_ENV: 'test' })).toBe(true)
    expect(devLoginEnabled({ DEV_LOGIN: '1', NODE_ENV: 'production' })).toBe(false)
    expect(devLoginEnabled({ NODE_ENV: 'development' })).toBe(false)
    expect(devLoginEnabled({ DEV_LOGIN: '0' })).toBe(false)
    expect(devLoginEnabled({ DEV_LOGIN: 'true' })).toBe(false)
  })
})

describe('buildAuthOptions', () => {
  test('email and password (the dev login) is off unless dev login is enabled', () => {
    expect(buildAuthOptions({ NODE_ENV: 'production', DEV_LOGIN: '1' }, {}).emailAndPassword?.enabled).toBe(false)
    expect(buildAuthOptions({}, {}).emailAndPassword?.enabled).toBe(false)
    expect(buildAuthOptions({ DEV_LOGIN: '1' }, {}).emailAndPassword?.enabled).toBe(true)
  })

  test('Google and GitHub register only when both of their env values exist', () => {
    expect(Object.keys(buildAuthOptions({}, {}).socialProviders ?? {})).toEqual([])
    expect(Object.keys(buildAuthOptions({ ...GOOGLE }, {}).socialProviders ?? {})).toEqual(['google'])
    expect(Object.keys(buildAuthOptions({ ...GITHUB }, {}).socialProviders ?? {})).toEqual(['github'])
    expect(Object.keys(buildAuthOptions({ ...GOOGLE, ...GITHUB }, {}).socialProviders ?? {}).sort()).toEqual(['github', 'google'])
    expect(Object.keys(buildAuthOptions({ GOOGLE_CLIENT_ID: 'only-id' }, {}).socialProviders ?? {})).toEqual([])
    expect(Object.keys(buildAuthOptions({ GITHUB_CLIENT_SECRET: 'only-secret' }, {}).socialProviders ?? {})).toEqual([])
  })

  test('tanstackStartCookies is the last plugin', () => {
    const plugins = buildAuthOptions({}, {}).plugins ?? []
    expect(plugins.length).toBeGreaterThan(0)
    expect(plugins[plugins.length - 1]!.id).toBe('tanstack-start-cookies')
  })
})

describe('authConfig', () => {
  test('tells the sign-in page which options exist, never the secrets', () => {
    expect(authConfig({})).toEqual({ google: false, github: false, dev: false })
    expect(authConfig({ ...GOOGLE, ...GITHUB, DEV_LOGIN: '1' })).toEqual({ google: true, github: true, dev: true })
    expect(authConfig({ ...GOOGLE, DEV_LOGIN: '1', NODE_ENV: 'production' })).toEqual({ google: true, github: false, dev: false })
  })
})

describe('Better Auth on the app schema (PGlite)', () => {
  let client: PGlite
  let db: PgliteDatabase<typeof schema>
  beforeAll(async () => {
    client = new PGlite()
    db = drizzle(client, { schema })
    await migrateDb(db)
  })
  afterAll(() => client.close())

  test('a dev user can sign up, sign in and read a session through the Drizzle adapter', async () => {
    const auth = createAuth(db, { DEV_LOGIN: '1', BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234' })
    const email = devEmail('ada')
    await auth.api.signUpEmail({ body: { email, password: DEV_PASSWORD, name: 'ada' } })
    const res = await auth.api.signInEmail({ body: { email, password: DEV_PASSWORD }, asResponse: true })
    expect(res.status).toBe(200)
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(session?.user.email).toBe(email)
    expect(session?.user.name).toBe('ada')
  })

  test('without dev login the same sign-up is refused', async () => {
    const auth = createAuth(db, { BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234' })
    await expect(auth.api.signUpEmail({ body: { email: devEmail('bob'), password: DEV_PASSWORD, name: 'bob' } })).rejects.toThrow()
  })

  test('sessions store no IP address and no raw user agent', async () => {
    const auth = createAuth(db, { DEV_LOGIN: '1', BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234' })
    const email = devEmail('probe')
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 ProbeBrowser/1.0' })
    await auth.api.signUpEmail({ body: { email, password: DEV_PASSWORD, name: 'probe' }, headers })
    await auth.api.signInEmail({ body: { email, password: DEV_PASSWORD }, headers })
    const rows = await db.select().from(schema.session)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      expect(row.ipAddress ?? '').toBe('')
      expect(row.userAgent ?? '').toBe('')
    }
    const all = JSON.stringify(rows)
    expect(all).not.toContain('203.0.113.7')
    expect(all).not.toContain('ProbeBrowser')
  })

  test('the auth rate limiter still throttles repeated sign-ins from one IP', async () => {
    const env = { DEV_LOGIN: '1', BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234' }
    const auth = betterAuth({ ...buildAuthOptions(env, db), rateLimit: { enabled: true } })
    const codes: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.9' },
          body: JSON.stringify({ email: devEmail('nobody'), password: 'wrong-password-123' }),
        }),
      )
      codes.push(res.status)
    }
    expect(codes[3]).toBe(429)
  })
})

describe('verified email on the dev sign-in (M4)', () => {
  const create = (env: Record<string, string>, user: Record<string, unknown>) =>
    (buildAuthOptions(env, {}).databaseHooks.user.create.before as (u: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>)(user)

  test('dev sign-ups count as verified; real providers keep what they report', async () => {
    expect((await create({ DEV_LOGIN: '1', NODE_ENV: 'test' }, { email: 'a@dev.invalid', emailVerified: false })).data.emailVerified).toBe(true)
    expect((await create({ ...GOOGLE }, { email: 'a@x.com', emailVerified: false })).data.emailVerified).toBe(false)
    expect((await create({ ...GOOGLE }, { email: 'a@x.com', emailVerified: true })).data.emailVerified).toBe(true)
  })
})
