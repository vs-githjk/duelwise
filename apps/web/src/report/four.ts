import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { COLS, ROWS, fourFromMoves, stoneAt, type FourState } from '@duelwise/core/src/games/four/rules'
import { solve } from '@duelwise/core/src/games/four/solver'
import type { FourView, Moment } from './types'
import { coachFour, type Coaching } from './four-coach'
import { walk } from './walk'

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
  return { moments, capped, solved, facts: { decisiveTurn: decisive } }
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
