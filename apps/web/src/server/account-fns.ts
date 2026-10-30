import { createServerFn } from '@tanstack/react-start'
import { callerFromRequest } from './caller'
import { getServerDb } from './server-db'
import { deleteAccount } from './account'

/** Deletes the signed-in player's account and matches. Guests have nothing to delete here. */
export const deleteMyAccount = createServerFn({ method: 'POST' }).handler(async (): Promise<{ deleted: boolean }> => {
  const who = await callerFromRequest()
  if (!who.userId) return { deleted: false }
  const { db } = await getServerDb()
  return { deleted: await deleteAccount(db, who.userId, who.guestId) }
})
