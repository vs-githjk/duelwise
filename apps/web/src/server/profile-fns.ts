import { createServerFn } from '@tanstack/react-start'
import { authConfig } from '../lib/auth'
import { callerFromRequest, getSessionUser } from './caller'
import { getServerDb } from './server-db'
import { viewerOf, type Viewer } from './viewer'
import { getSettings, markNoticeSeen, setTrainingAllowed, type Settings } from './profile'

/** Who is signed in, for the header menu. */
export const getViewer = createServerFn({ method: 'GET' }).handler(async (): Promise<Viewer> => {
  return viewerOf(await getSessionUser(), { OWNER_EMAILS: process.env.OWNER_EMAILS })
})

/** Which sign-in options this server offers. */
export const getAuthConfig = createServerFn({ method: 'GET' }).handler(async () => authConfig(process.env))

export const getTrainingSettings = createServerFn({ method: 'GET' }).handler(async (): Promise<Settings> => {
  const who = await callerFromRequest()
  const { db } = await getServerDb()
  return getSettings(db, who)
})

export const saveTrainingAllowed = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    if (typeof d !== 'object' || d === null || typeof (d as { allowed?: unknown }).allowed !== 'boolean') throw new Error('expected { allowed: boolean }')
    return { allowed: (d as { allowed: boolean }).allowed }
  })
  .handler(async ({ data }): Promise<Settings> => {
    const who = await callerFromRequest()
    const { db } = await getServerDb()
    await setTrainingAllowed(db, who, data.allowed)
    return getSettings(db, who)
  })

export const acknowledgeNotice = createServerFn({ method: 'POST' }).handler(async (): Promise<Settings> => {
  const who = await callerFromRequest()
  const { db } = await getServerDb()
  await markNoticeSeen(db, who)
  return getSettings(db, who)
})
