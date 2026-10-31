import { sql, type SQL } from 'drizzle-orm'
import * as schema from '../db/schema'
import { classCte, MATCH_CLS, MATCH_PID } from './traffic-sql'

type Env = { OWNER_EMAILS?: string | undefined }
const defaultEnv = (): Env => ({ OWNER_EMAILS: process.env.OWNER_EMAILS })

/**
 * Every public number (landing tallies, persona records, level boards, weekly stats, the latest feed) leaves Test traffic out.
 * "Test" is the same match-level class the owner dashboard uses (traffic-sql.ts), so the two always agree. Owner games are real
 * human play and stay in.
 */
export function notTestMatch(env: Env = defaultEnv()): SQL {
  return sql`${schema.match.id} not in (with ${classCte(env)} select m.id from match m left join pc on pc.pid = ${MATCH_PID} where ${MATCH_CLS} = 'test')`
}

/** A rated account that is Test traffic never ranks on a public board. `userId` is the column holding the user id. */
export function notTestUser(userId: SQL, env: Env = defaultEnv()): SQL {
  return sql`('u:' || ${userId}) not in (with ${classCte(env)} select pid from pc where cls = 'test')`
}
