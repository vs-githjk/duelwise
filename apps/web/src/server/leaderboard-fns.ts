import { createServerFn } from '@tanstack/react-start'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { getSessionUser } from './caller'
import { callerFromRequest } from './caller'
import { getShowOnLeaderboard, leaderboardViewHandler, setShowOnLeaderboard, type LeaderboardView } from './leaderboard'
import { getServerDb } from './server-db'
import { sweepAbandoned } from './matches'

export type { LeaderboardView }

export const getLeaderboardView = createServerFn({ method: 'GET' })
  .validator((d: unknown) => {
    const game = (d as { game?: unknown } | null)?.game
    if (typeof game !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCT.games, game)) throw new Error('unknown game')
    return { game: game as GameId }
  })
  .handler(async ({ data }): Promise<LeaderboardView> => {
    const { db } = await getServerDb()
    const user = await getSessionUser()
    return leaderboardViewHandler(db, data.game, user?.id ?? null, new Date(), sweepAbandoned)
  })

/** The signed-in player's leaderboard switch; null for a guest (guests have no rating and are never listed). */
export const getMyLeaderboardSwitch = createServerFn({ method: 'GET' }).handler(async (): Promise<{ show: boolean } | null> => {
  const user = await getSessionUser()
  if (!user) return null
  const { db } = await getServerDb()
  return { show: await getShowOnLeaderboard(db, user.id) }
})

export const saveLeaderboardSwitch = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    if (typeof d !== 'object' || d === null || typeof (d as { show?: unknown }).show !== 'boolean') throw new Error('expected { show: boolean }')
    return { show: (d as { show: boolean }).show }
  })
  .handler(async ({ data }): Promise<{ show: boolean } | null> => {
    const who = await callerFromRequest()
    if (!who.userId) return null
    const { db } = await getServerDb()
    await setShowOnLeaderboard(db, who, data.show)
    return { show: await getShowOnLeaderboard(db, who.userId) }
  })
