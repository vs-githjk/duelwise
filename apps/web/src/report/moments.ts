import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import { personaFor } from '../personas'
import { analyseChess, chessNearMiss, MATERIAL, type ChessEvaluator } from './chess'
import { fleetNearMiss } from './fleet'
import { fourNearMiss, fourReport } from './four'
import { isHumanLoss, type NearMiss } from './near-miss'
import { holdemNearMiss } from './holdem'
import { penaltyNearMiss } from './penalty'
import { puckNearMiss } from './puck'
import { realtimeNearMiss } from './realtime'
import { slackNearMiss } from './slack'
import { wordNearMiss } from './word'

// The near-miss contract lives in near-miss.ts (light, so the report page can import it); this file adds the per-game dispatcher.
export { NOT_CLOSE, isHumanLoss, nearMiss, publicNearMiss, showsNearMiss, type NearMiss } from './near-miss'

export interface NearMissOptions {
  /** 'result' is the player's own screen right after the match, where a line the coach already says is left out; 'report' (the default) is complete. */
  surface?: 'result' | 'report'
  /** Chess only: the evaluator for position scores. The result screen has the material count; the server report may pass the value net. */
  chessEvaluator?: ChessEvaluator
  /** Four in a Row only: the clock for the solver's time cap (tests). */
  now?: () => number
}

/**
 * The near miss for a finished record, replayed through the game core, or null when the game does not have one yet, the record was
 * made on an older core, or the match was a win or a draw. A loss that was not close gives `NOT_CLOSE`.
 */
export function nearMissFor(rec: MatchRecordV1, opponent: string = personaFor(rec.agent.level).name, opts: NearMissOptions = {}): NearMiss | null {
  if (getCore(rec.game).version !== rec.coreVersion) return null
  try {
    switch (rec.game) {
      case 'puck':
        return puckNearMiss(rec, opponent, opts.surface ?? 'report')
      case 'chess':
        return isHumanLoss(rec) ? chessNearMiss(rec, analyseChess(rec, opts.chessEvaluator ?? MATERIAL)) : null
      case 'four':
        return isHumanLoss(rec) ? fourNearMiss(rec, fourReport(rec, '', opts.now, opponent), opponent) : null
      case 'slack':
        return slackNearMiss(rec, opponent)
      case 'penalty':
        return penaltyNearMiss(rec)
      case 'fleet':
        return fleetNearMiss(rec, opponent)
      case 'word':
        return wordNearMiss(rec, opponent)
      case 'holdem':
        return holdemNearMiss(rec, opponent)
      case 'fighter':
      case 'arena':
        return realtimeNearMiss(rec, opponent)
      default:
        return null
    }
  } catch {
    return null
  }
}
