import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import * as schema from '../db/schema'
import { existingGuestId } from '../server/guest'
import { carryPokerOptOutAtSignIn } from '../server/poker-profile'

/** The slice of process.env this file reads, so tests pass their own. */
export interface AuthEnv {
  NODE_ENV?: string
  DEV_LOGIN?: string
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
}

/** Dev-only sign-in: DEV_LOGIN=1 and never in a production build. */
export function devLoginEnabled(env: AuthEnv): boolean {
  return env.DEV_LOGIN === '1' && env.NODE_ENV !== 'production'
}

export { DEV_PASSWORD, devEmail } from './dev-login'

export interface AuthConfig {
  google: boolean
  github: boolean
  dev: boolean
}

/** Which sign-in options this server offers. Safe to send to the browser: booleans only. */
export function authConfig(env: AuthEnv): AuthConfig {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    dev: devLoginEnabled(env),
  }
}

/** Better Auth options for an environment. `db` is a Drizzle database over the app schema. */
export function buildAuthOptions(env: AuthEnv, db: unknown) {
  const cfg = authConfig(env)
  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {}
  if (cfg.google) socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! }
  if (cfg.github) socialProviders.github = { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! }
  return {
    appName: 'Duelwise',
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db as never, { provider: 'pg', schema }),
    // Email and password exists only as the dev login; the sign-in page offers no password form otherwise.
    emailAndPassword: { enabled: cfg.dev, autoSignIn: true },
    socialProviders,
    // PRD section 9: IP addresses and raw user agents are never stored. Better Auth would otherwise
    // write both into every session row, so these hooks blank both on write. IP tracking itself stays on
    // because Better Auth's rate limiter needs it (it keeps its keys in memory, not in the database).
    databaseHooks: {
      // The dev sign-in has no inbox to verify: its users count as verified so the owner dashboard can be tried locally.
      user: { create: { before: async (user: Record<string, unknown>) => ({ data: cfg.dev ? { ...user, emailVerified: true } : user }) } },
      session: {
        create: {
          // Sign-in is the one moment an account and this browser's guest are known to be the same person. This runs before the session exists
          // and its failure stops the sign-in, on purpose: no session may exist with a poker opt-out left behind.
          before: async (session: Record<string, unknown>, ctx?: { headers?: Headers; request?: Request } | null) => {
            const cookie = (ctx?.headers ?? ctx?.request?.headers)?.get('cookie')
            await carryPokerOptOutAtSignIn(db as never, String(session.userId), await existingGuestId(db as never, cookie))
            return { data: { ...session, ipAddress: '', userAgent: '' } }
          },
        },
        update: { before: async (session: Record<string, unknown>) => ({ data: { ...session, ipAddress: '', userAgent: '' } }) },
      },
    },
    // Last in the list, as the TanStack Start guide requires.
    plugins: [tanstackStartCookies()],
  } satisfies BetterAuthOptions
}

export function createAuth(db: unknown, env: AuthEnv = process.env) {
  return betterAuth(buildAuthOptions(env, db))
}
