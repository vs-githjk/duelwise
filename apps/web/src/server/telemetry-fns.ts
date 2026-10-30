import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import type { GameId, Level } from '@duelwise/core/src/product'
import { getSessionUser } from './caller'
import { siteEloFor } from './matches'
import { getServerDb } from './server-db'
import { ownerViewHandler, revealEmailsHandler } from './telemetry-owner'
import { humanTargetFromSiteElo, type OwnerView } from './telemetry-stats'

const targetFor = (game: GameId, level: Level) => humanTargetFromSiteElo(siteEloFor(game, level))

/** The owner dashboard data, or null for anyone who is not on the OWNER_EMAILS allowlist (the route turns null into a 404). */
export const getOwnerView = createServerFn({ method: 'GET' })
  .validator((d: unknown) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}))
  .handler(async ({ data }): Promise<OwnerView | null> => {
    const { db } = await getServerDb()
    const r = await ownerViewHandler(db, await getSessionUser(), { OWNER_EMAILS: process.env.OWNER_EMAILS }, data, targetFor)
    if (r.status !== 200) {
      setResponseStatus(404)
      return null
    }
    return r.body as OwnerView
  })

/** Owner only: the emails of the asked players; every call is written to the audit table. */
export const revealOwnerEmails = createServerFn({ method: 'POST' })
  .validator((d: unknown) => d)
  .handler(async ({ data }): Promise<Record<string, string>> => {
    const { db } = await getServerDb()
    const r = await revealEmailsHandler(db, await getSessionUser(), { OWNER_EMAILS: process.env.OWNER_EMAILS }, data)
    if (r.status !== 200) {
      setResponseStatus(r.status)
      return {}
    }
    return (r.body as { emails: Record<string, string> }).emails
  })
