import type { MatchRecordV1 } from '@duelwise/core/src/match-record'

// The near-miss contract: after a loss that was close, one sentence for where it turned, one for how near it got, and two to four counts.
// Every game fills it from its replayed record (never from page state), and says nothing when the match was not close:
// a blowout, a win, a draw or a record that does not replay returns nothing to show. B2 fills the remaining games the same way.

export interface NearMiss {
  /** The one sentence naming the moment the match was decided, or null when the game has no such moment. */
  turning: string | null
  /** Two to four counts, in the order they read. Empty unless `close`. */
  stats: Array<{ label: string; value: number }>
  /** True only when the match was really close. When false there is nothing to show, and every other field is empty. */
  close: boolean
  /** How near it got, in one short sentence ("Before drop 21 you could still draw."). Null when `turning` already says it. */
  line: string | null
  /** `turning` and `line` worded about "the player", for the public report. */
  publicTurning: string | null
  publicLine: string | null
}

/** A loss that was not close: the strip is absent. */
export const NOT_CLOSE: NearMiss = { turning: null, stats: [], close: false, line: null, publicTurning: null, publicLine: null }

/** Builds a NearMiss from facts and enforces the contract: not close means nothing else is set; stats never exceed four. */
export function nearMiss(close: boolean, p: Partial<Omit<NearMiss, 'close'>>): NearMiss {
  if (!close) return NOT_CLOSE
  return {
    turning: p.turning ?? null,
    stats: (p.stats ?? []).slice(0, 4),
    close: true,
    line: p.line ?? null,
    publicTurning: p.publicTurning ?? p.turning ?? null,
    publicLine: p.publicLine ?? p.line ?? null,
  }
}

/** Whether there is anything to draw. */
export function showsNearMiss(nm: NearMiss | null | undefined): nm is NearMiss {
  return !!nm && nm.close && (nm.turning !== null || nm.line !== null || nm.stats.length > 0)
}

/** The same strip worded about "the player", for a report someone else is reading. */
export function publicNearMiss(nm: NearMiss): NearMiss {
  return { ...nm, turning: nm.publicTurning, line: nm.publicLine }
}

/** A loss of the human's that was played out to the end (a resignation has no moment to name). */
export function isHumanLoss(rec: MatchRecordV1): boolean {
  return rec.result.winner !== null && rec.result.winner !== rec.humanSeat && rec.result.reason !== 'resigned'
}

