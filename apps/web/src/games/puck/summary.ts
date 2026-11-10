import { PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import type { PuckState } from '@duelwise/core/src/games/puck/state'

/** Counters for one seat over the match: the sim's own event counts, which the replayed record reproduces. */
export interface SeatSummary {
  goals: number
  shots: number
  saves: number
  posts: number
  nearMisses: number
  fouls: number
}

export function summaryOf(s: PuckState, seat: 0 | 1): SeatSummary {
  const at = (kind: number): number => s.stats[seat * 6 + kind - 1] ?? 0
  return { goals: at(PUCK_EVENTS.goal), shots: at(PUCK_EVENTS.shot), saves: at(PUCK_EVENTS.save), posts: at(PUCK_EVENTS.post), nearMisses: at(PUCK_EVENTS.nearMiss), fouls: at(PUCK_EVENTS.foul) }
}

const n = (k: number, noun: string): string => `${k} ${noun}${k === 1 ? '' : 's'}`

/**
 * "7 goals, 9 straight shots on target, 5 saves." The sim counts a shot when a mallet touch sends the puck on a straight line through the
 * mouth, bounces ignored, so a goal off a bank shot or a long contact is a goal and not a shot: the goals sit beside the shots so the two
 * never look like they disagree. Posts and near misses are left out when there were none.
 */
export function summaryLine(m: SeatSummary): string {
  const parts = [n(m.goals, 'goal'), `${n(m.shots, 'straight shot')} on target`, n(m.saves, 'save')]
  if (m.posts > 0) parts.push(n(m.posts, 'post'))
  if (m.nearMisses > 0) parts.push(`${m.nearMisses} ${m.nearMisses === 1 ? 'near miss' : 'near misses'}`)
  return `${parts.join(', ')}.`
}
