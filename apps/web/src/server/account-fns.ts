import { createServerFn } from '@tanstack/react-start'
import { callerFromRequest } from './caller'
import { getServerDb } from './server-db'
import { deleteAccount, friendKeysFor } from './account'

/** Deletes the signed-in player's account and matches. Guests have nothing to delete here. Input: { deviceId? } (this browser's friend device id). */
export const deleteMyAccount = createServerFn({ method: 'POST' })
  .validator((d: unknown): { deviceId?: unknown } => (d && typeof d === 'object' ? (d as { deviceId?: unknown }) : {}))
  .handler(async ({ data }): Promise<{ deleted: boolean }> => {
    const who = await callerFromRequest()
    if (!who.userId) return { deleted: false }
    const { db } = await getServerDb()
    // A signed-in person's key does not depend on the device; games played signed out on this device sit under the device key.
    const friendKeys = await friendKeysFor(process.env.DUEL_SIGNING_SECRET, who.userId, data.deviceId)
    return { deleted: await deleteAccount(db, who.userId, who.guestId, friendKeys) }
  })
