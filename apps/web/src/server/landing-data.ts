import { getBoardCached, type Board } from './landing'
import { getOpponentRecordsCached, type OpponentRecord } from './board'
import type { getServerDb } from './server-db'

/** What the landing strip shows while the database cannot be read: no week yet. */
export const emptyBoard = (): Board => ({ matches: 0, humanWins: 0, perGame: [], latest: [] })

/**
 * The parts of the landing and /play that come from the database. Each one falls back to empty when the database is
 * unreachable (out of quota, down), so the registry-backed cards still render instead of an error page.
 */
export async function databaseParts(open: () => ReturnType<typeof getServerDb>): Promise<{ board: Board; records: OpponentRecord[] }> {
  let db: Awaited<ReturnType<typeof getServerDb>>['db']
  try {
    db = (await open()).db
  } catch (e) {
    console.error('landing: database unavailable', e)
    return { board: emptyBoard(), records: [] }
  }
  const [board, records] = await Promise.all([
    getBoardCached(db).catch((e) => (console.error('landing: board unavailable', e), emptyBoard())),
    getOpponentRecordsCached(db).catch((e) => (console.error('landing: opponent records unavailable', e), [] as OpponentRecord[])),
  ])
  return { board, records }
}
