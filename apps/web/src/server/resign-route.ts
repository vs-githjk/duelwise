import { getServerDb } from './server-db'
import { callerFromRequest } from './caller'
import { siteEloFor } from './matches'
import { resignMatchHandler } from './resign'

/** Used by the /api/resign route, which serves both the Resign button and the pagehide beacon. */
export async function resignFromRequest(input: unknown) {
  const { db } = await getServerDb()
  const who = await callerFromRequest()
  return resignMatchHandler(db, input, who, { siteElo: siteEloFor })
}
