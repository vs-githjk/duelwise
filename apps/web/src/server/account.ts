import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import { playerRef } from './telemetry'

type Db = PgDatabase<any, typeof schema>

/**
 * Removes an account and everything tied to it: matches and their reports, ratings, profile, sessions, linked
 * sign-in accounts, pending verifications and the user row. Matches this browser played as a
 * guest before signing in go too (only those still unclaimed). The user row is deleted last, so a
 * failure part way leaves an account that can simply try again. Returns false for an unknown user.
 */
export async function deleteAccount(db: Db, userId: string, guestId?: string): Promise<boolean> {
  const u = (await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId)).limit(1))[0]
  if (!u) return false
  const mine = and(eq(schema.match.guestId, guestId ?? ''), isNull(schema.match.userId))
  const doomed = await db.select({ id: schema.match.id }).from(schema.match).where(guestId ? or(eq(schema.match.userId, userId), mine) : eq(schema.match.userId, userId))
  if (doomed.length) await db.delete(schema.matchReport).where(inArray(schema.matchReport.matchId, doomed.map((m) => m.id)))
  await db.delete(schema.match).where(eq(schema.match.userId, userId))
  if (guestId) await db.delete(schema.telemetryEvent).where(eq(schema.telemetryEvent.playerRef, await playerRef('guest', guestId)))
  if (guestId) await db.delete(schema.match).where(and(eq(schema.match.guestId, guestId), isNull(schema.match.userId)))
  await db.delete(schema.telemetryEvent).where(eq(schema.telemetryEvent.playerRef, await playerRef('user', userId)))
  await db.delete(schema.rating).where(eq(schema.rating.userId, userId))
  await db.delete(schema.profile).where(eq(schema.profile.userId, userId))
  await db.delete(schema.verification).where(eq(schema.verification.identifier, u.email))
  await db.delete(schema.session).where(eq(schema.session.userId, userId))
  await db.delete(schema.account).where(eq(schema.account.userId, userId))
  await db.delete(schema.user).where(eq(schema.user.id, userId))
  return true
}
