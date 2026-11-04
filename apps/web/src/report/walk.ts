import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import type { Seat } from '@duelwise/core/src/types'

export interface Step<S, A> {
  /** Index of this step (the record's tick). */
  tick: number
  before: S
  after: S
  /** Who moved and what they played. Word Duel has both seats in one step. */
  moves: Array<{ seat: Seat; action: A }>
}

/**
 * Replays a turn-based record one tick at a time and hands each step back. The record has already
 * been verified by the server before it is stored, so a malformed one here only ends the walk early.
 */
export function walk<S = any, A = any>(rec: MatchRecordV1): Array<Step<S, A>> {
  const core = getCore(rec.game) as ReturnType<typeof getCore>
  const out: Array<Step<S, A>> = []
  let s = core.init(rec.seed, rec.options) as S
  let i = 0
  for (let tick = 0; !core.terminal(s as never); tick++) {
    const cur: [A | null, A | null] = [null, null]
    const moves: Array<{ seat: Seat; action: A }> = []
    while (i < rec.actions.length && rec.actions[i]![0] === tick) {
      const [, seat, n] = rec.actions[i]!
      const a = core.decodeAction(n) as A
      cur[seat] = a
      moves.push({ seat, action: a })
      i++
    }
    if (moves.length === 0) break
    const next = core.step(s as never, cur as never) as S
    out.push({ tick, before: s, after: next, moves })
    s = next
  }
  return out
}

/** How many actions the human played in a record. Turn-based games: one per move; the share card and the report read this same count. */
export function humanActionCount(rec: MatchRecordV1): number {
  // Stormglass records open with five placements per seat; they are setup, not moves, so only shots count.
  if (rec.game === 'fleet') {
    const core = getCore('fleet')
    return rec.actions.filter((a) => a[1] === rec.humanSeat && (core.decodeAction(a[2] as number) as { kind: string }).kind === 'shot').length
  }
  // Crosscurrent: a pass is not a move, so the count is discs placed.
  if (rec.game === 'slack') return rec.actions.filter((a) => a[1] === rec.humanSeat && a[2] !== 64).length
  // Twelve Yards: both seats pick on every tick, and the shooter is seat tick % 2, so the player's moves are the kicks they took (their dives are not counted as kicks).
  if (rec.game === 'penalty') return rec.actions.filter((a) => a[1] === rec.humanSeat && a[0] % 2 === rec.humanSeat).length
  return rec.actions.filter((a) => a[1] === rec.humanSeat).length
}
