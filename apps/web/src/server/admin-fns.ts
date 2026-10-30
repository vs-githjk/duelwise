import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import type { GameId } from '@duelwise/core/src/product'
import { getSessionUser } from './caller'
import { practiceLevelsOf } from './board'
import { getServerDb } from './server-db'
import { summariseRegistry } from './stats'
import { registryFor } from './stats-fns'
import { adminOverviewHandler, adminPeopleHandler, adminPlayerHandler, type AdminOverview, type PeoplePage, type PlayerDetail } from './admin-owner'

const env = () => ({ OWNER_EMAILS: process.env.OWNER_EMAILS })
const practiceLevels = (game: GameId) => practiceLevelsOf(summariseRegistry(registryFor(game)).levels)

/** Owner only: totals, 14-day trends and the latest 50 finished matches. Null for anyone else (the 404 status is set). */
export const getAdminOverview = createServerFn({ method: 'GET' }).handler(async (): Promise<AdminOverview | null> => {
  const { db } = await getServerDb()
  const r = await adminOverviewHandler(db, await getSessionUser(), env())
  if (r.status !== 200) {
    setResponseStatus(404)
    return null
  }
  return r.body as AdminOverview
})

/** Owner only: one page of the People table (sort, search and page are validated on the server). */
export const getAdminPeople = createServerFn({ method: 'GET' })
  .validator((d: unknown) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}))
  .handler(async ({ data }): Promise<PeoplePage | null> => {
    const { db } = await getServerDb()
    const r = await adminPeopleHandler(db, await getSessionUser(), env(), data)
    if (r.status !== 200) {
      setResponseStatus(404)
      return null
    }
    return r.body as PeoplePage
  })

/** Owner only: one player's match history and path progress, by their opaque ref. */
export const getAdminPlayer = createServerFn({ method: 'GET' })
  .validator((d: unknown) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}))
  .handler(async ({ data }): Promise<PlayerDetail | null> => {
    const { db } = await getServerDb()
    const r = await adminPlayerHandler(db, await getSessionUser(), env(), data, practiceLevels)
    if (r.status !== 200) {
      setResponseStatus(r.status)
      return null
    }
    return r.body as PlayerDetail
  })
