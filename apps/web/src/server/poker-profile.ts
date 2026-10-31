import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import type { Caller } from './match-handlers'
import { defaultTrainingAllowed, guestOptedOut } from './profile'

type Db = PgDatabase<any, typeof schema>

/**
 * The Hold'em play-profile switch. A profile is a set of counts about HOW a player plays (how often they raise, fold to a bet, reach
 * showdown), built offline from their stored matches for analysis. It is on unless the player switches it off, and it is separate from
 * the training switch: a player can allow training and refuse a profile, or the other way round. The profile builder reads this flag live
 * (apps/web/scripts/profile-holdem.ts), so switching off removes the player from the next build, past matches included.
 */
export async function getPokerProfileAllowed(db: Db, who: Caller): Promise<boolean> {
  if (who.userId) {
    const row = (await db.select({ v: schema.profile.pokerProfileAllowed }).from(schema.profile).where(eq(schema.profile.userId, who.userId)).limit(1))[0]
    // Opt-out wins: off on the account or on this browser reads as off. This is a read and never writes; sign-in stores the opt-out.
    return (row?.v ?? true) && !(await guestPokerOptedOut(db, who.guestId))
  }
  if (who.guestId) {
    const g = (await db.select({ v: schema.guest.pokerProfileAllowed }).from(schema.guest).where(eq(schema.guest.id, who.guestId)).limit(1))[0]
    return g ? g.v : true
  }
  return true
}

/**
 * Runs at every sign-in and sign-up, before the session exists (lib/auth.ts), in any order of events: an opt-out on either side of the sign-in
 * is stored on both. The export reads the account row for a signed-in player's matches and the guest row for what this browser played as a
 * guest, and a match row never holds both ids, so both rows must say off. An opt-in is never carried; it only happens on the switch itself.
 */
export async function carryPokerOptOutAtSignIn(db: Db, userId: string, guestId: string | undefined): Promise<void> {
  if (!guestId) return
  if (await guestPokerOptedOut(db, guestId)) {
    await db
      .insert(schema.profile)
      // A new row must not undo a training opt-out carried from the guest on this browser.
      .values({ userId, pokerProfileAllowed: false, trainingAllowed: (await guestOptedOut(db, guestId)) ? false : defaultTrainingAllowed() })
      .onConflictDoUpdate({ target: schema.profile.userId, set: { pokerProfileAllowed: false } })
    return
  }
  const account = (await db.select({ v: schema.profile.pokerProfileAllowed }).from(schema.profile).where(eq(schema.profile.userId, userId)).limit(1))[0]
  if (account?.v === false) await db.update(schema.guest).set({ pokerProfileAllowed: false }).where(eq(schema.guest.id, guestId))
}

/** True when this browser's guest row exists and has switched profiles off. Only opt-outs are carried to a signed-in user. */
export async function guestPokerOptedOut(db: Db, guestId: string | undefined): Promise<boolean> {
  if (!guestId) return false
  const g = (await db.select({ v: schema.guest.pokerProfileAllowed }).from(schema.guest).where(eq(schema.guest.id, guestId)).limit(1))[0]
  return g ? !g.v : false
}

/** Stores the choice. Signed in, it also switches off the guest row of this browser, whose earlier matches are not linked to the account. */
export async function setPokerProfileAllowed(db: Db, who: Caller, allowed: boolean): Promise<void> {
  if (who.userId) {
    await db
      .insert(schema.profile)
      // A new row must not undo a training opt-out carried from the guest on this browser.
      .values({ userId: who.userId, pokerProfileAllowed: allowed, trainingAllowed: (await guestOptedOut(db, who.guestId)) ? false : defaultTrainingAllowed() })
      .onConflictDoUpdate({ target: schema.profile.userId, set: { pokerProfileAllowed: allowed } })
    // The account and this browser's guest row move together, so an opt-in is not undone by a stale guest opt-out and an opt-out is not lost.
    if (who.guestId) await db.update(schema.guest).set({ pokerProfileAllowed: allowed }).where(eq(schema.guest.id, who.guestId))
    return
  }
  if (who.guestId) await db.update(schema.guest).set({ pokerProfileAllowed: allowed }).where(and(eq(schema.guest.id, who.guestId)))
}

