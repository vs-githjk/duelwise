import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { migrateDb } from '../db/migrate'
import * as schema from '../db/schema'
import { getPokerProfileAllowed, setPokerProfileAllowed } from '../server/poker-profile'
import { GUEST_COOKIE, resolveGuest } from '../server/guest'
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

describe('a guest poker opt-out at sign-in (PGlite, the real Better Auth flow)', () => {
  const env = { DEV_LOGIN: '1', BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234' }
  let client: PGlite
  let db: PgliteDatabase<typeof schema>
  beforeAll(async () => {
    client = new PGlite()
    db = drizzle(client, { schema })
    await migrateDb(db)
  })
  afterAll(() => client.close())

  const post = (auth: ReturnType<typeof createAuth>, path: string, body: unknown, cookie: string) =>
    auth.handler(new Request(`http://localhost:3000/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie }, body: JSON.stringify(body) }))
  const optedOutGuest = async () => {
    const g = await resolveGuest(db, null)
    await setPokerProfileAllowed(db, { guestId: g.id }, false)
    return { id: g.id, cookie: `${GUEST_COOKIE}=${g.id}` }
  }
  const userId = async (auth: ReturnType<typeof createAuth>, res: Response) => {
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    return (await auth.api.getSession({ headers: new Headers({ cookie }) }))!.user.id
  }

  test('signing up with an opted-out guest cookie writes the account row, so an account-only read says off', async () => {
    const auth = createAuth(db, env)
    const g = await optedOutGuest()
    const res = await post(auth, 'sign-up/email', { email: devEmail('new'), password: DEV_PASSWORD, name: 'new' }, g.cookie)
    expect(res.status).toBe(200)
    expect(await getPokerProfileAllowed(db, { userId: await userId(auth, res) })).toBe(false)
  })

  test('signing in to an existing account with no profile row carries it too', async () => {
    const auth = createAuth(db, env)
    const email = devEmail('rowless')
    await auth.api.signUpEmail({ body: { email, password: DEV_PASSWORD, name: 'rowless' } })
    const g = await optedOutGuest()
    const res = await post(auth, 'sign-in/email', { email, password: DEV_PASSWORD }, g.cookie)
    expect(res.status).toBe(200)
    const id = await userId(auth, res)
    expect((await db.select().from(schema.profile).where(eq(schema.profile.userId, id)))[0]?.pokerProfileAllowed).toBe(false)
  })

  test('signing in to an account whose row says on switches it off', async () => {
    const auth = createAuth(db, env)
    const email = devEmail('rowed')
    const first = await post(auth, 'sign-up/email', { email, password: DEV_PASSWORD, name: 'rowed' }, '')
    const id = await userId(auth, first)
    await setPokerProfileAllowed(db, { userId: id }, true)
    const g = await optedOutGuest()
    await post(auth, 'sign-in/email', { email, password: DEV_PASSWORD }, g.cookie)
    expect(await getPokerProfileAllowed(db, { userId: id })).toBe(false)
  })

  test('the OAuth callback, the only sign-in production has, carries it too (no network: the token call is stubbed and anything else throws)', async () => {
    const google = {
      clientId: 'g-id', clientSecret: 'g-secret',
      getUserInfo: async () => ({ user: { id: 'google-1', email: 'oauth@example.com', name: 'Oauth', emailVerified: true }, data: { sub: 'google-1' } }) as never,
    }
    const auth = betterAuth({ ...buildAuthOptions({ ...env, BETTER_AUTH_URL: 'http://localhost:3000' }, db), socialProviders: { google } })
    const g = await optedOutGuest()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      if (!String(url).startsWith('https://oauth2.googleapis.com/token')) throw new Error(`unexpected network call: ${String(url)}`)
      return Response.json({ access_token: 'token', token_type: 'bearer', expires_in: 3600 })
    }) as typeof fetch
    try {
      const start = await post(auth as never, 'sign-in/social', { provider: 'google', callbackURL: '/' }, g.cookie)
      const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')
      const cookie = [g.cookie, ...start.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ')
      const res = await auth.handler(new Request(`http://localhost:3000/api/auth/callback/google?code=c&state=${state}`, { headers: { cookie } }))
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).not.toContain('error')
      const id = await userId(auth as never, res)
      expect((await db.select().from(schema.profile).where(eq(schema.profile.userId, id)))[0]?.pokerProfileAllowed).toBe(false)
      expect(await getPokerProfileAllowed(db, { userId: id })).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a forged guest cookie changes nothing, and a sign-in that cannot carry the opt-out gets no session', async () => {
    const auth = createAuth(db, env)
    const res = await post(auth, 'sign-up/email', { email: devEmail('forged'), password: DEV_PASSWORD, name: 'forged' }, `${GUEST_COOKIE}=00000000-0000-0000-0000-000000000000`)
    expect(res.status).toBe(200)
    expect(await db.select().from(schema.profile).where(eq(schema.profile.userId, await userId(auth, res)))).toHaveLength(0)

    const g = await optedOutGuest()
    const hook = buildAuthOptions(env, { select: () => { throw new Error('database down') } }).databaseHooks.session.create.before as (s: Record<string, unknown>, ctx: unknown) => Promise<unknown>
    await expect(hook({ userId: 'u-x' }, { headers: new Headers({ cookie: g.cookie }) })).rejects.toThrow('database down')
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
