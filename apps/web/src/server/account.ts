import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import { playerRef } from './telemetry'
import { playerKey } from './duel-token'

const DEVICE_ID = /^[0-9a-f-]{36}$/i

/**
 * The head-to-head keys that belong to this person: the one tied to their account (the same on every device) and, when the browser sends its
 * friend device id, the one games played signed out on that device were stored under. No secret means friend links are off and nothing was stored.
 */
export async function friendKeysFor(secret: string | undefined, userId: string, deviceId: unknown): Promise<string[]> {
  if (!secret || secret.length < 16) return []
  const keys = [await playerKey(secret, { userId }, '')]
  if (typeof deviceId === 'string' && DEVICE_ID.test(deviceId)) keys.push(await playerKey(secret, {}, deviceId))
  return keys
}

type Db = PgDatabase<any, typeof schema>

/** Postgres undefined_table. Drizzle may wrap the driver error, so look one level down as well. */
const isMissingTable = (e: unknown): boolean => {
  const code = (x: unknown) => (x && typeof x === 'object' ? (x as { code?: unknown }).code : undefined)
  return code(e) === '42P01' || code((e as { cause?: unknown } | null)?.cause) === '42P01'
}

/** Head-to-head rows for these keys. A database that has not run migration 0009 yet has no such table, so there is nothing to remove; any other error is real. */
async function deleteFriendRows(db: Db, keys: string[]): Promise<void> {
  try {
    await db.delete(schema.friendResult).where(or(inArray(schema.friendResult.playerA, keys), inArray(schema.friendResult.playerB, keys)))
  } catch (e) {
    if (!isMissingTable(e)) throw e
  }
}

/**
 * Removes an account and everything tied to it: matches and their reports, ratings, profile, sessions, linked
 * sign-in accounts, pending verifications, friend head-to-head results (when given the person's friend key and, for games played signed out, the device key) and the user row. Matches this browser played as a
 * guest before signing in go too (only those still unclaimed). The user row is deleted last, so a
 * failure part way leaves an account that can simply try again. Returns false for an unknown user.
 */
export async function deleteAccount(db: Db, userId: string, guestId?: string, friendKeys?: string | string[]): Promise<boolean> {
  const u = (await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId)).limit(1))[0]
  if (!u) return false
  const mine = and(eq(schema.match.guestId, guestId ?? ''), isNull(schema.match.userId))
  const doomed = await db.select({ id: schema.match.id }).from(schema.match).where(guestId ? or(eq(schema.match.userId, userId), mine) : eq(schema.match.userId, userId))
  if (doomed.length) await db.delete(schema.matchReport).where(inArray(schema.matchReport.matchId, doomed.map((m) => m.id)))
  await db.delete(schema.match).where(eq(schema.match.userId, userId))
  if (guestId) await db.delete(schema.telemetryEvent).where(eq(schema.telemetryEvent.playerRef, await playerRef('guest', guestId)))
  if (guestId) await db.delete(schema.match).where(and(eq(schema.match.guestId, guestId), isNull(schema.match.userId)))
  await db.delete(schema.telemetryEvent).where(eq(schema.telemetryEvent.playerRef, await playerRef('user', userId)))
  const keys = [friendKeys ?? []].flat().filter(Boolean)
  if (keys.length) await deleteFriendRows(db, keys)
  await db.delete(schema.rating).where(eq(schema.rating.userId, userId))
  await db.delete(schema.profile).where(eq(schema.profile.userId, userId))
  await db.delete(schema.verification).where(eq(schema.verification.identifier, u.email))
  await db.delete(schema.session).where(eq(schema.session.userId, userId))
  await db.delete(schema.account).where(eq(schema.account.userId, userId))
  await db.delete(schema.user).where(eq(schema.user.id, userId))
  return true
}
