import type { DeathLine } from './hud'
import { PHASE } from '@duelwise/core/src/games/arena/state'

export interface SightLog {
  since: number | null
  lastBefore?: [number | null, number | null]
  shot: [number | null, number | null]
}

export const newSightLog = (): SightLog => ({ since: null, shot: [null, null], lastBefore: [null, null] })

// Per-frame LIVE update of one observer's log. Losing sight starts a new window but keeps the last-shot frames,
// so a shot fired just before the next sight still counts as "already firing".
export function stepSight(log: SightLog, visible: boolean, bothAlive: boolean, frame: number): SightLog {
  if (visible) return log.since === null ? { ...log, since: frame } : log
  if (!bothAlive) return log
  return { since: null, shot: [null, null], lastBefore: log.lastBefore ? [log.lastBefore[0], log.lastBefore[1]] : [null, null] }
}

export function noteShot(log: SightLog, seat: 0 | 1, frame: number): void {
  if (log.since !== null) {
    if (log.shot[seat] === null) log.shot[seat] = frame
  } else if (log.lastBefore) log.lastBefore[seat] = frame
}

export const resetSightOnTransition = (previous: number, current: number): boolean => current === PHASE.BUY && current !== previous

export function reactionLine(sight: SightLog, firstShot: [number | null, number | null], frame: number, limitMs: number, youDied: boolean): DeathLine {
  const since = sight.since ?? frame
  const shotOf = (seat: 0 | 1): number | null => {
    const shot = sight.shot[seat] ?? firstShot[seat]
    return shot === null || sight.since === null ? null : shot - since
  }
  return { aiAlreadyFiring: sight.since !== null && sight.lastBefore?.[1] != null && sight.since - sight.lastBefore[1] <= 12, seenAt: 0, aiShotAt: shotOf(1), youShotAt: shotOf(0), limitMs, youDied }
}
