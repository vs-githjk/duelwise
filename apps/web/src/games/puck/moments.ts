import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { GOALS_TO_WIN, PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import { goalPips, goalTimelineLine, nearMissLine, puckTimeline, turningPointFor, type GoalPip } from '../../report/puck'
import { personaFor } from '../../personas'
import { isCloseLoss } from '../../lib/says'
import type { Layout } from './input'
import type { PuckState } from '@duelwise/core/src/games/puck/state'

// Close-game moments and the turning point. Every line comes from the sim's own events (the same ones the record replays to),
// never from the page's mood: if the sim did not raise it, nothing flashes.

/** A line that flashes on the table for a moment, such as "Match point" or "Post!". */
export interface Moment {
  /** Unique per moment, so the same words twice in a row still animate. */
  id: number
  text: string
  /** 'you' tints it in your colour, 'them' in the opponent's, 'neutral' in ink. */
  tone: 'you' | 'them' | 'neutral'
}

const YOU = 0

/** Close enough to be worth a line: one side has 4 or more and the sides are within one goal. Posts are rare, so they speak whenever they happen. */
const tight = (s: PuckState): boolean => Math.max(s.score[0], s.score[1]) >= 4 && Math.abs(s.score[0] - s.score[1]) <= 1

/** "Next goal wins" the moment the clock ends level (the page calls this when `sudden` flips on). */
export function suddenMoment(nextId: number): Moment {
  return { id: nextId, text: 'Next goal wins', tone: 'neutral' }
}

/**
 * Called after every sim tick that raised an event (s.ev is non-zero). Returns the line to flash, or null. At most one
 * per tick, and only when it is true and close: a goal that puts someone on match point, a goal that makes it 6 to 6,
 * a post, and (only when it is tight) a save or a near miss. A goal that is simply a goal speaks through the score.
 */
export function momentFor(s: PuckState, nextId: number, opponent = 'They'): Moment | null {
  if (s.ev === 0) return null
  const at = GOALS_TO_WIN - 1
  if (s.ev & (1 << PUCK_EVENTS.goal)) {
    if (s.matchOver === 1) return null
    if (s.score[0] === at && s.score[1] === at) return { id: nextId, text: 'Next goal wins', tone: 'neutral' }
    const scorer = s.lastEventKind === PUCK_EVENTS.goal ? s.lastEventSeat : -1
    if (scorer >= 0 && s.score[scorer] === at && s.score[1 - scorer]! < at) {
      return scorer === YOU ? { id: nextId, text: 'Match point', tone: 'you' } : { id: nextId, text: 'Match point against you', tone: 'them' }
    }
    return null
  }
  // Only the last counted event of the tick is named (lastEvent*), and only if it happened on the tick just stepped. emit() stamps
  // lastEventFrame inside the tick, before stepState advances frame, so on the state we are handed that is frame - 1.
  if (s.lastEventFrame !== s.frame - 1) return null
  const mine = s.lastEventSeat === YOU
  switch (s.lastEventKind) {
    case PUCK_EVENTS.post:
      return mine ? { id: nextId, text: 'Off the post!', tone: 'you' } : { id: nextId, text: `${opponent} hit the post`, tone: 'them' }
    case PUCK_EVENTS.nearMiss:
      if (!tight(s)) return null
      return mine ? { id: nextId, text: 'Just wide!', tone: 'you' } : { id: nextId, text: `${opponent} just missed`, tone: 'them' }
    case PUCK_EVENTS.save:
      if (!tight(s)) return null
      return mine ? { id: nextId, text: 'Great save', tone: 'you' } : { id: nextId, text: `${opponent} saves`, tone: 'them' }
    default:
      return null
  }
}

/** The line on the result that names where the match turned, replayed from the record only. Null when nothing is worth saying. */
export function turningPointLine(record: MatchRecordV1): string | null {
  return turningPointFor(record)
}

/**
 * For a loss that was near: "You took Sable to 5 to 7." Dropped for a one goal loss, because the coach line under the score already says
 * "One goal short against Sable" (lib/says.ts isCloseLoss); a sudden death line adds the extra fact, so it stays.
 */
export function nearMissSummary(record: MatchRecordV1): string | null {
  const covered = record.result.reason !== 'sudden' && isCloseLoss({ game: 'puck', result: record.result, humanSeat: record.humanSeat, humanMoves: 0 })
  if (covered) return null
  return nearMissLine(record, personaFor(record.agent.level).name)
}

const cache = new WeakMap<MatchRecordV1, { turning: string | null; nearMiss: string | null }>()
const pipCache = new WeakMap<MatchRecordV1, { pips: GoalPip[]; label: string | null }>()

/** The goal pips for the result screen and the sentence that labels them, replayed from the record once. Empty when no goal was counted. */
export function finishedPips(record: MatchRecordV1): { pips: GoalPip[]; label: string | null } {
  let hit = pipCache.get(record)
  if (!hit) {
    const opponent = personaFor(record.agent.level).name
    const events = puckTimeline(record)
    hit = { pips: goalPips(events, record.humanSeat, record.result.winner, opponent), label: goalTimelineLine(events, record.humanSeat, opponent) }
    pipCache.set(record, hit)
  }
  return hit
}

/** Both result lines for a finished record, computed once per record (the turning point replays the whole match, about 40 ms for a long one). */
export function finishedLines(record: MatchRecordV1): { turning: string | null; nearMiss: string | null } {
  let hit = cache.get(record)
  if (!hit) {
    hit = { turning: turningPointLine(record), nearMiss: nearMissSummary(record) }
    cache.set(record, hit)
  }
  return hit
}

/**
 * Where the serve pill and the moment pill live: the middle of the centre line, in screen px. Both ends of the table belong to a goal mouth
 * and a mallet (the opponent's mallet is hidden behind a pill placed there while you aim), and the serving puck waits near its own server's
 * end, so the centre line is the one spot that covers neither a goal, a mallet nor a standing puck.
 */
export function pillAnchor(l: Layout): { left: number; top: number } {
  return l.landscape ? { left: l.x + l.scale, top: l.y + l.scale / 2 } : { left: l.x + l.scale / 2, top: l.y + l.scale }
}
