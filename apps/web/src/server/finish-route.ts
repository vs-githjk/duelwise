import { getServerDb } from './server-db'
import { callerFromRequest } from './caller'
import { serverFinishOptions } from './finish-options'
import { finishMatchHandler } from './match-handlers'

/** Used by the /api/finish route, which accepts a raw gzip record from the pagehide beacon and the next-load retry. */
export async function finishFromRequest(bytes: Uint8Array) {
  const { db } = await getServerDb()
  const who = await callerFromRequest()
  return finishMatchHandler(db, bytes, who, serverFinishOptions())
}
