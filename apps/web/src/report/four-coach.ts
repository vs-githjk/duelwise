import { COLS, drop, fourFromMoves, isFull, isLegalColumn, type FourState } from '@duelwise/core/src/games/four/rules'

/** Search nodes one coaching pass may spend; the solver-free path must stay cheap. */
const NODE_BUDGET = 400_000

export type CoachKind = 'win' | 'block' | 'forced'

export interface Coaching {
  /** Index into the move list of the human drop that could have been better. */
  index: number
  played: number
  /** Better columns (0-based), best first. */
  better: number[]
  kind: CoachKind
  /** For `forced`: how many of the AI's own drops its forced win needed. */
  within?: number
}

const legalCols = (s: FourState): number[] => {
  const out: number[] = []
  for (let c = 0; c < COLS; c++) if (isLegalColumn(s, c)) out.push(c)
  return out
}

/**
 * True when the side to move can force a win within `depth` plies (its own drops count (depth + 1) / 2).
 * A depth-limited search for wins only: a plain, cheap threat check for positions the solver skips.
 */
export function forcedWin(s: FourState, depth: number, budget: { left: number } = { left: NODE_BUDGET }): boolean {
  if (s.winner !== null || isFull(s) || budget.left <= 0) return false
  budget.left--
  const mine = legalCols(s)
  for (const c of mine) if (drop(s, c).winner !== null) return true
  if (depth < 3) return false
  for (const c of mine) {
    const n = drop(s, c)
    if (isFull(n)) continue
    let all = true
    for (const r of legalCols(n)) {
      const m = drop(n, r)
      if (m.winner !== null || !forcedWin(m, depth - 2, budget)) {
        all = false
        break
      }
    }
    if (all) return true
  }
  return false
}

const hasImmediateWin = (s: FourState): boolean => legalCols(s).some((c) => drop(s, c).winner !== null)

const RANK: Record<CoachKind, number> = { win: 3, block: 2, forced: 1 }

/**
 * Looks at every drop the human made and finds one with a clearly better column, using only wins and
 * blocks plus a short forced-win search, so it works in the early game where the solver does not run.
 * Priority: a missed win, then a missed block, then a drop that allowed a forced loss; ties go to the
 * latest drop (the last chance to change the game). Null when the human did nothing of the kind.
 */
export function coachFour(cols: readonly number[], humanSeat: 0 | 1): Coaching | null {
  const budget = { left: NODE_BUDGET }
  let best: Coaching | null = null
  for (let i = 0; i < cols.length; i++) {
    if (i % 2 !== humanSeat) continue
    const before = fourFromMoves(cols.slice(0, i))
    if (before.winner !== null) break
    const played = cols[i]!
    const mine = legalCols(before)
    let found: Coaching | null = null

    const wins = mine.filter((c) => drop(before, c).winner !== null)
    if (wins.length > 0 && !wins.includes(played)) found = { index: i, played, better: wins, kind: 'win' }

    if (!found) {
      const after = drop(before, played)
      if (after.winner === null && hasImmediateWin(after)) {
        const safe = mine.filter((c) => {
          const n = drop(before, c)
          return n.winner === null && !hasImmediateWin(n)
        })
        if (safe.length > 0) found = { index: i, played, better: safe, kind: 'block' }
      }
      if (!found && after.winner === null && !isFull(after)) {
        for (const depth of [3, 5]) {
          if (!forcedWin(after, depth, budget)) continue
          const safe = mine.filter((c) => {
            const n = drop(before, c)
            return n.winner === null && !forcedWin(n, depth, budget)
          })
          if (safe.length > 0) found = { index: i, played, better: safe, kind: 'forced', within: (depth + 1) / 2 }
          break
        }
      }
    }
    if (found && (!best || RANK[found.kind] >= RANK[best.kind])) best = found
  }
  return best
}
