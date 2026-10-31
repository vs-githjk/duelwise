import { getRequestHeader, getRequestHeaders, setResponseHeader } from '@tanstack/react-start/server'
import { createAuth } from '../lib/auth'
import { getServerDb } from './server-db'
import { claimGuestForOwner, existingGuestId, resolveGuest } from './guest'
import { cookieSecure } from './origin'
import { userOrNull } from './safe-user'
import type { Caller } from './match-handlers'
import { isOwner } from './telemetry'
import { isTestRequest, requestTraffic, TEST_HEADER } from './traffic'

let auth: ReturnType<typeof createAuth> | null = null

/** The Better Auth instance for this process, built on the app database on first use. */
export async function getAuth() {
  if (auth) return auth
  const { db } = await getServerDb()
  auth = createAuth(db)
  return auth
}

/** The signed-in user for this request, or null. */
export async function getSessionUser() {
  return userOrNull(async () => {
    const a = await getAuth()
    const s = await a.api.getSession({ headers: getRequestHeaders() })
    return s?.user
  })
}

/** The player behind this request: the signed-in user, else a guest from the cookie (a new cookie is set when needed). */
export async function callerFromRequest(): Promise<Caller> {
  const user = await getSessionUser()
  const { db } = await getServerDb()
  const facts = { userAgent: getRequestHeader('user-agent'), cookie: getRequestHeader('cookie'), testHeader: getRequestHeader(TEST_HEADER) }
  const owner = isOwner(user, { OWNER_EMAILS: process.env.OWNER_EMAILS })
  const traffic = requestTraffic({ ...facts, owner })
  // A signed-in user keeps the browser's existing guest id, so an opt-out made as a guest still applies.
  if (user) {
    const guestId = await existingGuestId(db, getRequestHeader('cookie'))
    // The guest this owner browsed as before signing in is the owner's too, but only when it has no earlier matches: the owner
    // signing in on someone else's browser must not relabel that person's history. Later matches are tagged by the owner session.
    if (owner && guestId) await claimGuestForOwner(db, guestId).catch(() => false)
    return { userId: user.id, guestId, traffic }
  }
  const g = await resolveGuest(db, getRequestHeader('cookie'), cookieSecure(process.env), isTestRequest(facts) ? 'test' : 'human')
  if (g.setCookie) setResponseHeader('set-cookie', g.setCookie)
  return { guestId: g.id, traffic }
}

/** Like callerFromRequest, but never creates a guest or sets a cookie: for read-only pages that only want to know who is looking. */
export async function viewerFromRequest(): Promise<Caller> {
  const user = await getSessionUser()
  const { db } = await getServerDb()
  const guestId = await existingGuestId(db, getRequestHeader('cookie'))
  return { ...(user ? { userId: user.id } : {}), ...(guestId ? { guestId } : {}) }
}
