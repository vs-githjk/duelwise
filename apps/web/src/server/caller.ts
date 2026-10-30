import { getRequestHeader, getRequestHeaders, setResponseHeader } from '@tanstack/react-start/server'
import { createAuth } from '../lib/auth'
import { getServerDb } from './server-db'
import { existingGuestId, resolveGuest } from './guest'
import { cookieSecure } from './origin'
import { userOrNull } from './safe-user'
import type { Caller } from './match-handlers'

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
  // A signed-in user keeps the browser's existing guest id, so an opt-out made as a guest still applies.
  if (user) return { userId: user.id, guestId: await existingGuestId(db, getRequestHeader('cookie')) }
  const g = await resolveGuest(db, getRequestHeader('cookie'), cookieSecure(process.env))
  if (g.setCookie) setResponseHeader('set-cookie', g.setCookie)
  return { guestId: g.id }
}

/** Like callerFromRequest, but never creates a guest or sets a cookie: for read-only pages that only want to know who is looking. */
export async function viewerFromRequest(): Promise<Caller> {
  const user = await getSessionUser()
  const { db } = await getServerDb()
  const guestId = await existingGuestId(db, getRequestHeader('cookie'))
  return { ...(user ? { userId: user.id } : {}), ...(guestId ? { guestId } : {}) }
}
