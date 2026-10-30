import { createServerFn } from '@tanstack/react-start'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { getSessionUser } from './caller'
import { getServerDb } from './server-db'
import { getBoardCached, getMyRecord, type Board, type MyRecord } from './landing'
import { gameRecordsTrainable, registryFor } from './stats-fns'
import { summariseRegistry } from './stats'
import { getOpponentRecordsCached, type OpponentRecord } from './board'
import { learningStrip, tileNote, type LearningFacts } from '../lib/tile-copy'

export interface CardData {
  game: GameId
  /** Champion version from the registry, null when the game has no registry file. */
  version: string | null
  /** Levels with a measured block, out of four. */
  measured: number
  /** When the champion was promoted, null when it has not been. */
  promotedAt: string | null
  /** The version the champion replaced, null for a first version. */
  parent: string | null
  /** True only when the registry's Champion level is published (measured). */
  championPublished: boolean
  /** The tile's one line, from the game and its registry. */
  note: string
  /** The registry's honesty switch: this game's agent trains on human matches. */
  learnsFromHumans: boolean
}

export interface LandingData {
  cards: CardData[]
  board: Board
  /** Each opponent's wins and losses against people, last 30 days, all games. */
  records: OpponentRecord[]
  /** The landing strip's third stat. */
  learning: { headline: string; body: string }
}

function cards(): CardData[] {
  return (Object.keys(PRODUCT.games) as GameId[]).map((game) => {
    const s = summariseRegistry(registryFor(game))
    const champion = s.history.find((h) => h.version === s.version)
    return { game, version: s.version, measured: s.publishedCount, promotedAt: s.promotedAt ?? null, parent: champion?.parent ?? null, championPublished: s.levels.some((l) => l.level === 'champion' && l.state === 'measured'), note: tileNote(game, s), learnsFromHumans: gameRecordsTrainable(game) }
  })
}

function learning(cs: CardData[]): { headline: string; body: string } {
  const facts: LearningFacts[] = cs.map((c) => {
    const s = summariseRegistry(registryFor(c.game))
    const row = s.history.find((h) => h.version === s.version)
    return { game: c.game, learnsFromHumans: c.learnsFromHumans, version: s.version, promotedAt: s.promotedAt, parent: row?.parent ?? null, humanMatchesUsed: row?.humanMatchesUsed ?? 0 }
  })
  return learningStrip(facts)
}

/** Everything the landing and the dashboard show: registry facts and the database's 7-day board. */
export const getLandingData = createServerFn({ method: 'GET' }).handler(async (): Promise<LandingData> => {
  const { db } = await getServerDb()
  const cs = cards()
  return { cards: cs, board: await getBoardCached(db), records: await getOpponentRecordsCached(db), learning: learning(cs) }
})

export interface DashboardData extends LandingData {
  /** Null for guests. */
  mine: MyRecord | null
}

export const getDashboardData = createServerFn({ method: 'GET' }).handler(async (): Promise<DashboardData> => {
  const { db } = await getServerDb()
  const user = await getSessionUser()
  const cs = cards()
  return { cards: cs, board: await getBoardCached(db), records: await getOpponentRecordsCached(db), learning: learning(cs), mine: user ? await getMyRecord(db, user.id, 5, new Date(), (g) => gameRecordsTrainable(g)) : null }
})

/** The opponents' wins and losses against people over the window (the same cached numbers the fight card shows), for the line after a loss. */
export const getOpponentRecordsView = createServerFn({ method: 'GET' }).handler(async (): Promise<OpponentRecord[]> => {
  const { db } = await getServerDb()
  return getOpponentRecordsCached(db)
})
