import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { PRODUCT } from '@duelwise/core/src/product'
import * as schema from '../db/schema'
import type { Caller } from './match-handlers'

type Db = PgDatabase<any, typeof schema>

export interface Settings {
  trainingAllowed: boolean
  /** The player has read and dismissed the training notice. */
  noticeSeen: boolean
  signedIn: boolean
}

/** Legitimate interest: matches train the agents unless the player opts out. Opt-in: only if they tick it. */
export function defaultTrainingAllowed(basis: 'legitimate-interest' | 'opt-in' = PRODUCT.trainingDataBasis): boolean {
  return basis === 'legitimate-interest'
}

async function read(db: Db, who: Caller): Promise<{ trainingAllowed: boolean; noticeSeenAt: Date | null } | null> {
  if (who.userId) {
    return (await db.select().from(schema.profile).where(eq(schema.profile.userId, who.userId)).limit(1))[0] ?? null
  }
  if (who.guestId) {
    return (await db.select().from(schema.guest).where(eq(schema.guest.id, who.guestId)).limit(1))[0] ?? null
  }
  return null
}

/** True when this browser's guest row exists and has opted out. Only opt-outs are ever carried to a signed-in user. */
export async function guestOptedOut(db: Db, guestId: string | undefined): Promise<boolean> {
  if (!guestId) return false
  const g = (await db.select({ t: schema.guest.trainingAllowed }).from(schema.guest).where(eq(schema.guest.id, guestId)).limit(1))[0]
  return g ? !g.t : false
}

export async function getSettings(db: Db, who: Caller): Promise<Settings> {
  const row = await read(db, who)
  const carried = !row && who.userId ? await guestOptedOut(db, who.guestId) : false
  return {
    trainingAllowed: carried ? false : (row?.trainingAllowed ?? defaultTrainingAllowed()),
    noticeSeen: Boolean(row?.noticeSeenAt),
    signedIn: Boolean(who.userId),
  }
}

/**
 * Stores the choice. Opting out also clears the flag on the player's earlier matches, so nothing
 * they played reaches an export; opting back in applies to matches from now on only.
 */
export async function setTrainingAllowed(db: Db, who: Caller, allowed: boolean): Promise<void> {
  const revoke = { trainingAllowed: false, filterFlags: sql`case when coalesce(${schema.match.filterFlags}, '{}'::jsonb) ? 'deferredCheckAt' then coalesce(${schema.match.filterFlags}, '{}'::jsonb) || '{"deferredTrainingRevoked":true}'::jsonb else ${schema.match.filterFlags} end` }
  if (who.userId) {
    await db
      .insert(schema.profile)
      .values({ userId: who.userId, trainingAllowed: allowed })
      .onConflictDoUpdate({ target: schema.profile.userId, set: { trainingAllowed: allowed } })
    if (!allowed) {
      await db.update(schema.match).set(revoke).where(eq(schema.match.userId, who.userId))
      // Matches this browser played as a guest before signing in.
      if (who.guestId) {
        await db.update(schema.match).set(revoke).where(and(eq(schema.match.guestId, who.guestId), isNull(schema.match.userId)))
        await db.update(schema.guest).set({ trainingAllowed: false }).where(eq(schema.guest.id, who.guestId))
      }
    }
    return
  }
  if (who.guestId) {
    const updated = await db.update(schema.guest).set({ trainingAllowed: allowed }).where(eq(schema.guest.id, who.guestId)).returning({ id: schema.guest.id })
    if (updated.length > 0 && !allowed) {
      await db.update(schema.match).set(revoke).where(and(eq(schema.match.guestId, who.guestId), isNull(schema.match.userId)))
    }
  }
}

export async function markNoticeSeen(db: Db, who: Caller): Promise<void> {
  const now = new Date()
  if (who.userId) {
    await db
      .insert(schema.profile)
      .values({ userId: who.userId, trainingAllowed: (await guestOptedOut(db, who.guestId)) ? false : defaultTrainingAllowed(), noticeSeenAt: now })
      .onConflictDoUpdate({ target: schema.profile.userId, set: { noticeSeenAt: now } })
    return
  }
  if (who.guestId) await db.update(schema.guest).set({ noticeSeenAt: now }).where(eq(schema.guest.id, who.guestId))
}
