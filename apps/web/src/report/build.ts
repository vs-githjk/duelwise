import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import { PRODUCT } from '@duelwise/core/src/product'
import { resultSentence } from '../lib/copy'
import { personaFor } from '../personas'
import { analyseChess, chessReport, MATERIAL, type ChessEvaluator } from './chess'
import { fourReport, fourView, solverNote } from './four'
import { chessReaction } from './reaction'
import type { Moment, ReportBody } from './types'
import { wordReport } from './word'
import { walk, humanActionCount } from './walk'
import { holdemMoments } from './holdem'
import { fleetMoments } from './fleet'
import { slackReport } from './slack'
import { penaltyReport } from './penalty'
import { realtimeFacts, realtimeMoments, realtimeCoaching } from './realtime'

export interface BuildOptions {
  /** The chess evaluator: the value net on the server when it loads, else material (the default). */
  chessEvaluator?: ChessEvaluator
  /** The opponent's name for sentences. Default: the persona of the level played. */
  opponent?: string
}

/**
 * Builds the player's report body from a stored record by replaying it through the game core.
 * Deterministic for a given record and evaluator. Throws only if the record cannot be replayed,
 * which the upload check has already ruled out for a valid match.
 */
export function buildReportBody(rec: MatchRecordV1, opts: BuildOptions = {}): ReportBody {
  const body = buildBody(rec, opts)
  // The closing moment repeats the result sentence; give it the same "the player" wording as `publicReason`.
  const moments = body.moments.map((m) => (m.kind === 'end' && m.publicText === undefined ? { ...m, publicText: m.text.replace(body.reason, body.publicReason) } : m))
  return { ...body, moments }
}

function buildBody(rec: MatchRecordV1, opts: BuildOptions): ReportBody {
  const opponent = opts.opponent ?? personaFor(rec.agent.level).name
  const outcome = rec.result.winner === null ? 'draw' : rec.result.winner === rec.humanSeat ? 'win' : 'loss'
  const sentence = resultSentence(rec.result, rec.humanSeat, opponent)
  const publicSentence = resultSentence(rec.result, rec.humanSeat, opponent, true)
  const kind = PRODUCT.games[rec.game].kind
  const base: ReportBody = {
    game: rec.game,
    level: rec.agent.level,
    outcome,
    reason: sentence,
    publicReason: publicSentence,
    moves: humanActionCount(rec),
    rounds: kind === 'realtime' ? { you: rec.result.score[rec.humanSeat], ai: rec.result.score[1 - rec.humanSeat] } : null,
    durationMs: Math.max(0, Date.parse(rec.endedAt) - Date.parse(rec.startedAt)),
    blunders: null,
    evaluator: 'none',
    moments: [],
    series: null,
    wordRows: null,
    reaction: null,
    note: null,
  }
  // A record from an older core version cannot be replayed faithfully (a seed can pick a different word now), so give the result only.
  if (getCore(rec.game).version !== rec.coreVersion) {
    return {
      ...base,
      moments: [{ kind: 'end', label: kind === 'realtime' ? 'Final score' : 'Result', tag: 'result', text: sentence }],
      note: 'This match was played on an older version of the game, so its key moments are not available.',
    }
  }
  if (rec.game === 'chess') {
    const ev = opts.chessEvaluator ?? MATERIAL
    const a = analyseChess(rec, ev)
    const r = chessReport(rec, a, sentence)
    return {
      ...base,
      moves: r.humanMoves,
      blunders: r.blunders,
      evaluator: ev.kind,
      moments: r.moments,
      series: r.series,
      reaction: chessReaction(outcome, r.facts, ev.kind),
      note: ev.kind === 'material' ? "The score here is a plain material count, because the AI's own position scorer was not available when this report was built." : null,
    }
  }
  if (rec.game === 'four') {
    const r = fourReport(rec, sentence, undefined, opponent)
    const n = walk(rec).filter((s) => s.moves[0]!.seat === rec.humanSeat).length
    return {
      ...base,
      moves: n,
      evaluator: 'solver',
      fourView: fourView(rec),
      moments: r.moments,
      note: solverNote(r.solved, r.capped),
    }
  }
  if (rec.game === 'word') {
    const steps = walk<{ answer: string }, string>(rec)
    const answer = steps[steps.length - 1]?.after.answer ?? ''
    const r = wordReport(rec, answer, sentence, opponent)
    return { ...base, moves: steps.length, moments: r.moments, wordRows: r.rows }
  }
  const end: Moment = { kind: 'end', label: kind === 'realtime' ? 'Final score' : 'Result', tag: 'result', text: sentence }
  // Fleet has its own report and must never fall to the Hold'em path below.
  if (rec.game === 'fleet') return { ...base, moments: fleetMoments(rec, sentence, opponent) }
  // Crosscurrent has its own report and must never fall to the Hold'em path below.
  if (rec.game === 'slack') {
    const r = slackReport(rec, sentence, opponent)
    return { ...base, moments: r.moments, series: r.series, slackView: r.view, note: r.note }
  }
  // Twelve Yards has its own report and must never fall to the Hold'em path below.
  if (rec.game === 'penalty') {
    const r = penaltyReport(rec, sentence, opponent)
    return { ...base, moves: r.yourKicks, moments: r.moments, penaltyView: r.view, note: r.note }
  }
  if (kind === 'realtime') {
    const facts = realtimeFacts(rec)
    const coaching = realtimeCoaching(rec, facts, opponent)
    const me = rec.humanSeat
    return {
      ...base,
      moves: humanActionCount(rec),
      moments: [...realtimeMoments(rec, facts, opponent), ...(coaching ? [coaching] : []), end],
    }
  }
  // Hold'em: the player's real action count and the hands that moved the most chips.
  return { ...base, moves: humanActionCount(rec), moments: [...holdemMoments(rec, opponent), end] }
}
