import { createServerFn } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { callerFromRequest, viewerFromRequest } from './caller'
import { GUEST_COOKIE } from './guest'
import { getServerDb } from './server-db'
import { getIdentity, saveName, setGuestBoardVisibility, type Identity } from './identity'
import { setShowOnLeaderboard } from './leaderboard'
import { getPath, type PathMap } from './path'
import { getLevelBoard, practiceLevelsOf, type LevelBoard } from './board'
import { registryFor } from './stats-fns'
import { summariseRegistry } from './stats'
import { sweepAbandoned } from './matches'
import type { NameCheck } from '../lib/display-name'

const gameInput = (d: unknown): { game: GameId } => {
  const game = (d as { game?: unknown } | null)?.game
  if (typeof game !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCT.games, game)) throw new Error('unknown game')
  return { game: game as GameId }
}

/** The saved name and board switch for whoever is looking. A visitor with no cookie yet reads as nobody; nothing is created. */
export const getMyIdentity = createServerFn({ method: 'GET' }).handler(async (): Promise<Identity> => {
  const who = await viewerFromRequest()
  if (!who.userId && !who.guestId) return { name: null, signedIn: false, showOnBoard: true }
  const { db } = await getServerDb()
  return getIdentity(db, who)
})

export const saveMyName = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ name: (d as { name?: unknown } | null)?.name }))
  .handler(async ({ data }): Promise<NameCheck> => {
    const who = await callerFromRequest()
    const { db } = await getServerDb()
    return saveName(db, who, data.name)
  })

/** Show or hide the player on the public board: a guest on their guest row, a signed-in player on their profile. */
export const saveBoardVisibility = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    if (typeof (d as { show?: unknown } | null)?.show !== 'boolean') throw new Error('expected { show: boolean }')
    return { show: (d as { show: boolean }).show }
  })
  .handler(async ({ data }): Promise<{ show: boolean }> => {
    const who = await callerFromRequest()
    const { db } = await getServerDb()
    if (who.userId) await setShowOnLeaderboard(db, who, data.show)
    if (who.guestId) await setGuestBoardVisibility(db, who.guestId, data.show)
    return { show: data.show }
  })

/** The viewer's adventure path in one game, from the match store. */
export const getMyPath = createServerFn({ method: 'GET' })
  .validator(gameInput)
  .handler(async ({ data }): Promise<PathMap> => {
    const who = await viewerFromRequest()
    const { db } = await getServerDb()
    return getPath(db, who, data.game)
  })

/** One game's board: a column per level, everybody, last 30 days. */
export const getLevelBoardView = createServerFn({ method: 'GET' })
  .validator(gameInput)
  .handler(async ({ data }): Promise<LevelBoard> => {
    const who = await viewerFromRequest()
    const { db } = await getServerDb()
    await sweepAbandoned(db)
    const practice = practiceLevelsOf(summariseRegistry(registryFor(data.game)).levels)
    return getLevelBoard(db, data.game, who, practice)
  })

/** "Forget me on this device": clears this browser's guest cookie. Matches and names already posted stay on the board as they were posted. */
export const forgetThisDevice = createServerFn({ method: 'POST' }).handler(async (): Promise<{ ok: true }> => {
  setResponseHeader('set-cookie', `${GUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
  return { ok: true }
})
