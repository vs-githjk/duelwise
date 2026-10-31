import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import { personaFor } from '../personas'

type Db = PgDatabase<any, typeof schema>

/** 'headless' is automated test traffic (a headless browser such as Playwright's); the owner pages leave those players out by default. */
export type DeviceClass = 'phone' | 'tablet' | 'desktop' | 'headless' | 'unknown'

/**
 * Reduces a browser string to a class. Only the class is ever stored; the string itself is read once,
 * here, and dropped, which is what the privacy page promises.
 */
export function deviceClass(userAgent: string | null | undefined): DeviceClass {
  const ua = userAgent ?? ''
  if (/HeadlessChrome|PhantomJS/i.test(ua)) return 'headless'
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet'
  if (/iPhone|iPod|Mobile|Android/i.test(ua)) return 'phone'
  if (/Windows NT|Macintosh|X11|CrOS|Linux/i.test(ua)) return 'desktop'
  return 'unknown'
}

/**
 * An opaque, stable reference to a player for the owner dashboard: a short hash, never the id itself.
 * Web Crypto, not node:crypto, because the server-function modules are also bundled for the browser.
 */
export async function playerRef(kind: 'user' | 'guest', id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${id}`)))
  return `pl_${Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export interface EventInput {
  kind: schema.TelemetryKind
  matchId: string
  game: string
  level: string
  who: { userId?: string | null; guestId?: string | null }
  /** Device class of the request; later events of a match reuse the one stored at start. */
  device?: DeviceClass
  /** Only for the start event: whether the match may be used for training. */
  trainingAllowed?: boolean
  durationMs?: number | null
  outcome?: 'human' | 'ai' | 'draw' | null
  reason?: string | null
}

/**
 * Writes one lifecycle event. Never throws: a telemetry failure must not break a match, a rating or
 * an upload, so errors are logged (message only) and swallowed.
 */
export async function recordEvent(db: Db, e: EventInput): Promise<void> {
  try {
    const who = e.who.userId ? ({ kind: 'user', id: e.who.userId } as const) : e.who.guestId ? ({ kind: 'guest', id: e.who.guestId } as const) : null
    if (!who) return
    let device = e.device ?? 'unknown'
    let optedOut = e.trainingAllowed === undefined ? false : !e.trainingAllowed
    if (e.kind !== 'match_started') {
      const first = (
        await db
          .select({ device: schema.telemetryEvent.device, optedOut: schema.telemetryEvent.optedOut })
          .from(schema.telemetryEvent)
          .where(and(eq(schema.telemetryEvent.matchId, e.matchId), eq(schema.telemetryEvent.kind, 'match_started')))
          .limit(1)
      )[0]
      if (first) {
        device = e.device ?? (first.device as DeviceClass)
        optedOut = first.optedOut
      }
    }
    await db.insert(schema.telemetryEvent).values({
      id: crypto.randomUUID(),
      kind: e.kind,
      matchId: e.matchId,
      game: e.game as GameId,
      level: e.level,
      persona: personaFor(e.level as Level)?.name ?? e.level,
      device,
      durationMs: e.durationMs ?? null,
      outcome: e.outcome ?? null,
      reason: e.reason ?? null,
      trainingBasis: PRODUCT.trainingDataBasis,
      optedOut,
      playerRef: await playerRef(who.kind, who.id),
      playerKind: who.kind,
    })
  } catch (err) {
    console.error('telemetry write failed', err instanceof Error ? err.message : err)
  }
}

/** The OWNER_EMAILS allowlist: comma separated emails or user ids, trimmed and lower-cased. Empty when unset. */
export function ownerEntries(env: { OWNER_EMAILS?: string | undefined }): string[] {
  return (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

/**
 * True only when the signed-in user's id is on the allowlist, or their email is on it and the provider has verified
 * that email (an unverified address could be claimed by anyone who signs up with it). An id needs no check: it cannot
 * be chosen. With no allowlist nobody is the owner.
 */
export function isOwner(
  user: { id: string; email?: string | null; emailVerified?: boolean | null } | null | undefined,
  env: { OWNER_EMAILS?: string | undefined },
): boolean {
  if (!user) return false
  const list = ownerEntries(env)
  if (list.length === 0) return false
  if (list.includes(user.id.toLowerCase())) return true
  return user.emailVerified === true && !!user.email && list.includes(user.email.toLowerCase())
}
