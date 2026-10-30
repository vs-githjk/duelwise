import { eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import { defaultTrainingAllowed } from './profile'

type Db = PgDatabase<any, typeof schema>

export const GUEST_COOKIE = 'dw_guest'
const ONE_YEAR_S = 60 * 60 * 24 * 365

export interface GuestResolution {
  id: string
  /** True when a new guest row was written. */
  created: boolean
  /** A Set-Cookie header value, only when the cookie must be (re)issued. */
  setCookie?: string
}

function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

export function guestCookieHeader(id: string, secure: boolean): string {
  return `${GUEST_COOKIE}=${id}; Path=/; Max-Age=${ONE_YEAR_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/** The guest id in the cookie, if it points at an existing guest row. Never creates one. */
export async function existingGuestId(db: Db, cookieHeader: string | null | undefined): Promise<string | undefined> {
  const existing = readCookie(cookieHeader, GUEST_COOKIE)
  if (!existing || !/^[0-9a-f-]{36}$/.test(existing)) return undefined
  const row = (await db.select({ id: schema.guest.id }).from(schema.guest).where(eq(schema.guest.id, existing)).limit(1))[0]
  return row?.id
}

/**
 * Finds the guest named by the cookie, or creates one. The cookie is only a pointer: an id that is
 * not in the guest table is ignored and replaced, so a forged cookie cannot claim anyone's matches.
 */
export async function resolveGuest(db: Db, cookieHeader: string | null | undefined, secure = false): Promise<GuestResolution> {
  const existing = readCookie(cookieHeader, GUEST_COOKIE)
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) {
    const row = (await db.select({ id: schema.guest.id }).from(schema.guest).where(eq(schema.guest.id, existing)).limit(1))[0]
    if (row) return { id: row.id, created: false }
  }
  const id = crypto.randomUUID()
  await db.insert(schema.guest).values({ id, trainingAllowed: defaultTrainingAllowed() })
  return { id, created: true, setCookie: guestCookieHeader(id, secure) }
}
