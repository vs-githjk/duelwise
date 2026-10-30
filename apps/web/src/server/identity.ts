import { eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import { checkName, type NameCheck } from '../lib/display-name'
import { defaultTrainingAllowed, guestOptedOut } from './profile'

type Db = PgDatabase<any, typeof schema>
type Who = { userId?: string; guestId?: string }

export interface Identity {
  /** The name saved for the board, null when none. */
  name: string | null
  signedIn: boolean
  /** Whether the player appears on the public board. */
  showOnBoard: boolean
}

/**
 * The player's saved name. A signed-in player's name lives on their profile; when they have none yet and this browser's guest row has one,
 * it is copied across (this is "keep my name on other devices": signing in is the only step).
 */
export async function getIdentity(db: Db, who: Who): Promise<Identity> {
  const guest = who.guestId ? (await db.select().from(schema.guest).where(eq(schema.guest.id, who.guestId)).limit(1))[0] : undefined
  if (who.userId) {
    const p = (await db.select().from(schema.profile).where(eq(schema.profile.userId, who.userId)).limit(1))[0]
    let name = p?.displayName ?? null
    if (!name && guest?.displayName) {
      name = guest.displayName
      await upsertProfileName(db, who, name)
    }
    return { name, signedIn: true, showOnBoard: p?.showOnLeaderboard ?? true }
  }
  return { name: guest?.displayName ?? null, signedIn: false, showOnBoard: guest?.showOnLeaderboard ?? true }
}

async function upsertProfileName(db: Db, who: Who, name: string | null): Promise<void> {
  await db
    .insert(schema.profile)
    .values({ userId: who.userId!, trainingAllowed: (await guestOptedOut(db, who.guestId)) ? false : defaultTrainingAllowed(), displayName: name })
    .onConflictDoUpdate({ target: schema.profile.userId, set: { displayName: name } })
}

/** Saves the name after the same check the browser ran. A signed-in player's name goes to their profile and to this browser's guest row, so both read the same. */
export async function saveName(db: Db, who: Who, raw: unknown): Promise<NameCheck> {
  const checked = checkName(raw)
  if (!checked.ok) return checked
  if (who.userId) await upsertProfileName(db, who, checked.name)
  if (who.guestId) await db.update(schema.guest).set({ displayName: checked.name }).where(eq(schema.guest.id, who.guestId))
  return checked
}

/** Guests opt out of the public board here; a signed-in player uses the profile switch in leaderboard.ts. */
export async function setGuestBoardVisibility(db: Db, guestId: string, show: boolean): Promise<void> {
  await db.update(schema.guest).set({ showOnLeaderboard: show }).where(eq(schema.guest.id, guestId))
}
