import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { COLS, ROWS, fourFromMoves, stoneAt, type FourState } from '@duelwise/core/src/games/four/rules'
import { solve } from '@duelwise/core/src/games/four/solver'
import type { FourView, Moment } from './types'
import { coachFour, type Coaching } from './four-coach'
import { walk } from './walk'
import { isHumanLoss, nearMiss, NOT_CLOSE, type NearMiss } from './near-miss'

/** The solver is only asked once this many stones are down; earlier positions can take minutes. */
export const SOLVER_FROM_STONES = 14
/** Wall-clock cap for all solving in one report. */
const SOLVER_BUDGET_MS = 4000

type Verdict = 1 | 0 | -1

const word = (v: Verdict): string => (v === 1 ? 'a win' : v === -1 ? 'a loss' : 'a draw')

export interface FourReport {
  moments: Moment[]
  /** True when the time cap stopped the solver before the end. */
  capped: boolean
  /** How many positions the perfect solver actually checked. */
  solved: number
  facts: { decisiveTurn: string | null }
  /** What the near-miss strip is built from: the player's drop that made the position lost, the cheap fallback, and how long the solver could vouch for the player. */
  slip: { index: number; played: number; from: Verdict; to: Verdict; best: number[] } | null
  coach: Coaching | null
  /** The player's drops that the solver checked and found still winning or drawing for them. */
  held: number
  /** Drops in the whole game, by both sides. */
  drops: number
}

/**
 * Where a drop of the decisive disc changed what perfect play could still get. For every position
 * from SOLVER_FROM_STONES stones on, the weak solver says win, draw or loss for the side to move;
 * a move that makes that worse for its player is a drop that threw something away.
 */
export function fourReport(rec: MatchRecordV1, reason: string, now: () => number = Date.now, opponent = 'the AI'): FourReport {
  const steps = walk<FourState, number>(rec)
  const started = now()
  let capped = false
  let solved = 0
  const cols: number[] = []
  // verdict[k]: value for the side to move in the position before step k (null: not solved).
  const verdict: Array<{ v: Verdict; best: number[] } | null> = []
  steps.forEach((st) => {
    cols.push(st.moves[0]!.action)
    let entry: { v: Verdict; best: number[] } | null = null
    if (st.before.n >= SOLVER_FROM_STONES && !capped) {
      if (now() - started > SOLVER_BUDGET_MS) capped = true
      else {
        const r = solve(fourFromMoves(cols.slice(0, -1)), { weak: true, ttBits: 20 })
        entry = { v: Math.sign(r.score) as Verdict, best: r.bestMoves }
        solved++
      }
    }
    verdict.push(entry)
  })

  const moments: Moment[] = []
  let decisive: string | null = null
  let human: { k: number; label: string; from: Verdict; to: Verdict; best: number[] } | null = null
  let ai: { k: number; label: string } | null = null
  steps.forEach((st, k) => {
    const mover = st.moves[0]!.seat
    const here = verdict[k]
    if (!here) return
    const afterV: Verdict | null = st.after.winner !== null ? (st.after.winner === mover ? 1 : -1) : verdict[k + 1] ? ((-verdict[k + 1]!.v) as Verdict) : null
    if (afterV === null || afterV >= here.v) return
    const label = `Drop ${k + 1}: column ${st.moves[0]!.action + 1}`
    if (mover === rec.humanSeat) {
      if (!human || afterV < human.to) human = { k, label, from: here.v, to: afterV, best: here.best }
    } else if (!ai) ai = { k, label }
  })
  const h = human as null | { k: number; label: string; from: Verdict; to: Verdict; best: number[] }
  const a = ai as null | { k: number; label: string }
  // No solver verdict named a human drop (the game was decided before the solver starts, or it hit its
  // time cap): fall back to the cheap win, block and short forced-win check, so a lost game still says
  // which column to play.
  const humanWon = rec.result.winner === rec.humanSeat
  const coach = !h && !humanWon ? coachFour(cols, rec.humanSeat) : null
  if (coach) {
    const label = `Drop ${coach.index + 1}: column ${coach.played + 1}`
    decisive = label
    const which = coachColumns(coach)
    const why = coachReason(coach, opponent)
    moments.push({
      kind: 'worst',
      label,
      tag: 'a better drop',
      text: `You could have played ${which}. ${why}`,
      publicText: `The player could have played ${which}. ${why}`,
    })
  }
  if (h) {
    const kept = h.best.length === 1 ? `Column ${h.best[0]! + 1} kept it.` : `Columns ${h.best.map((c) => c + 1).join(', ')} kept it.`
    decisive = h.label
    moments.push({
      kind: 'worst',
      label: h.label,
      tag: 'decisive drop',
      text: `This took the best you could still get from ${word(h.from)} to ${word(h.to)}. ${kept}`,
      publicText: `This took the best the player could still get from ${word(h.from)} to ${word(h.to)}. ${kept}`,
    })
  }
  if (a) moments.push({ kind: 'turning', label: a.label, tag: `${opponent} slipped`, text: 'This drop let a better result back to you than the position had given it.', publicText: 'This drop let a better result back to the player than the position had given it.' })
  moments.sort((x, y) => Number(x.label.match(/\d+/)![0]) - Number(y.label.match(/\d+/)![0]))
  moments.push({ kind: 'end', label: `Drop ${steps.length}`, tag: 'last drop', text: reason })
  const held = steps.filter((st, k) => st.moves[0]!.seat === rec.humanSeat && (verdict[k]?.v ?? -1) >= 0).length
  const slip = h ? { index: h.k, played: steps[h.k]!.moves[0]!.action, from: h.from, to: h.to, best: h.best } : null
  return { moments, capped, solved, facts: { decisiveTurn: decisive }, slip, coach, held, drops: steps.length }
}

function coachColumns(c: Coaching): string {
  const cols = c.better.slice(0, 3).map((x) => x + 1)
  return cols.length === 1 ? `column ${cols[0]}` : `column ${cols.slice(0, -1).join(', ')} or ${cols.at(-1)}`
}

function coachReason(c: Coaching, opponent: string): string {
  if (c.kind === 'win') return 'It made four in a row.'
  if (c.kind === 'block') return `${coachColumns(c).replace(/^column/, 'Column')} would have blocked ${opponent}'s four in a row.`
  return `After the drop that was played, ${opponent} could force a win within ${c.within} of its own drops.`
}

/** The final board (player discs 1, AI discs 2, top row first) and the drops in order, for the report page. */
export function fourView(rec: MatchRecordV1): FourView {
  const steps = walk<FourState, number>(rec)
  const last = steps.at(-1)?.after ?? fourFromMoves([])
  const cells: FourView['cells'] = []
  for (let row = ROWS - 1; row >= 0; row--) {
    cells.push(
      Array.from({ length: COLS }, (_, col) => {
        const v = stoneAt(last, col, row)
        return v === 0 ? 0 : (v - 1 === rec.humanSeat ? 1 : 2)
      }),
    )
  }
  const drops = steps.map((st) => ({ by: st.moves[0]!.seat === rec.humanSeat ? ('player' as const) : ('ai' as const), column: st.moves[0]!.action + 1 }))
  return { cells, drops }
}

const positions = (n: number): string => (n === 1 ? '1 position' : `${n} positions`)

/** What the perfect solver actually did in this report, in plain words. Never claims a check that did not run. */
export function solverNote(solved: number, capped: boolean): string {
  if (capped) return `The solver ran out of time after ${positions(solved)}, so only the first part of the game, from disc ${SOLVER_FROM_STONES + 1} on, was checked.`
  if (solved === 0) return `The game ended before the perfect solver's starting point (disc ${SOLVER_FROM_STONES + 1}), so it did not run.`
  return `The perfect solver checked ${positions(solved)}, from disc ${SOLVER_FROM_STONES + 1} on.`
}

/** A fallback (no solver verdict) claim of a near miss needs a game at least this long: a missed block in the first few drops is a quick loss, not a close one. */
export const COACH_NEAR_MISS_DROPS = 20

/**
 * The near miss of a lost game, from the same solver pass the report runs. Close when the perfect solver said the player could still win
 * or draw right before the drop that made the position lost; or, where the solver did not reach, when a long game was lost to one drop the
 * cheap check can name (a missed win or block). Every claim is a solver or board fact, never a guess about who played well.
 */
export function fourNearMiss(rec: MatchRecordV1, r: FourReport, opponent: string): NearMiss | null {
  if (!isHumanLoss(rec)) return null
  const s = r.slip
  if (s && s.to === -1 && s.from >= 0) {
    const kept = s.best.length === 1 ? `Column ${s.best[0]! + 1} kept it.` : `Columns ${s.best.map((c) => c + 1).join(', ')} kept it.`
    const could = s.from === 1 ? 'win' : 'draw'
    return nearMiss(true, {
      turning: `Drop ${s.index + 1}, column ${s.played + 1}, was where it turned: after it the solver says ${opponent} wins. ${kept}`,
      line: `Before drop ${s.index + 1} you could still ${could}.`,
      publicLine: `Before drop ${s.index + 1} the player could still ${could}.`,
      stats: [
        { label: 'Drops that still held a win or draw', value: r.held },
        { label: 'Drops after it turned', value: r.drops - s.index - 1 },
      ],
    })
  }
  const c = r.coach
  if (!s && c && r.drops >= COACH_NEAR_MISS_DROPS) {
    const cols = c.better.slice(0, 3).map((x) => x + 1)
    const which = cols.length === 1 ? `column ${cols[0]}` : `column ${cols.slice(0, -1).join(', ')} or ${cols.at(-1)}`
    const why = coachReason(c, opponent)
    return nearMiss(true, {
      turning: `At drop ${c.index + 1} you could have played ${which}. ${why}`,
      publicTurning: `At drop ${c.index + 1} the player could have played ${which}. ${why}`,
      stats: [{ label: 'Drops after it', value: r.drops - c.index - 1 }],
    })
  }
  return NOT_CLOSE
}
