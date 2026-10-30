import { checkAgentMoves, checkBudgetMs, type AgentCheck } from './agent-check'
import { isTimeCapped, makeServerAgent } from './agent-models'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import type { Level } from '@duelwise/core/src/product'
import { siteOrigin, type SiteEnv } from './origin'

/**
 * The H1 check as production runs it: the server's copy of the shipped opponent re-plays the record (agent-check.ts).
 * The page's e2e specs play a random-move opponent (dev only), which a real check would reject; their server sets
 * DUELWISE_AGENT_CHECK=off, honoured outside production builds only. Its own file so tests can load it without the vite-only registry glob that matches.ts uses.
 */
export function serverVerifyAgent(env: SiteEnv = process.env): (rec: MatchRecordV1) => Promise<AgentCheck> {
  const site = siteOrigin(env)
  const off = env.DUELWISE_AGENT_CHECK === 'off' && env.NODE_ENV !== 'production'
  return async (rec) => (off ? { kind: 'verified' } : checkAgentMoves(rec, { makeAgent: (g, l, seat) => makeServerAgent(g, l, seat, site), budgetMs: checkBudgetMs(rec.game, rec.agent.level as Level), timeCapped: isTimeCapped }))
}
