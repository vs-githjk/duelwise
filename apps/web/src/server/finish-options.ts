import { gameRecordsTrainable } from './stats-fns'
import { agentVersionFor, siteEloFor } from './matches'
import type { FinishOptions } from './match-handlers'
import { serverVerifyAgent } from './verify-agent'
import { requestWaitUntil, type WaitUntil } from './wait-until'

/**
 * What every path that finishes a match passes to the handler: the site Elo, the training rule, the H1 check that
 * re-runs the opponent on the server (verify-agent.ts) and, where the platform offers it, the hook that lets a guest's
 * check finish after the answer. Server only: matches.ts loads it inside its handler, so the
 * agent code and node:fs it reaches never enter the browser bundle.
 */
export function serverFinishOptions(env: Record<string, string | undefined> = process.env, waitUntil: WaitUntil | undefined = requestWaitUntil()): FinishOptions {
  return { siteElo: siteEloFor, recordsTrainable: gameRecordsTrainable, verifyAgent: serverVerifyAgent(env), deferCheck: waitUntil, currentAgentVersion: agentVersionFor }
}
