import { CELLS, COLS, drop, isLegalColumn, type FourState } from '@duelwise/core/src/games/four/rules'
import { SolveLimitError, solve } from '@duelwise/core/src/games/four/solver'
import type { Rng } from '@duelwise/core/src/types'

// One-move tactics for Four in a Row, used by Medium (always take a win, always block) and by the
// Hard and Champion move picker (never choose a move that hands the opponent an immediate win).

/** Columns where the side to move wins on the spot. */
export function winningColumns(s: FourState): number[] {
  if (s.winner !== null || s.n >= CELLS) return []
  const out: number[] = []
  for (let c = 0; c < COLS; c++) if (isLegalColumn(s, c) && drop(s, c).winner !== null) out.push(c)
  return out
}

/** Columns where the opponent of the side to move would win on the spot if it were their turn. */
export function threatColumns(s: FourState): number[] {
  if (s.winner !== null || s.n + 1 >= CELLS) return []
  return winningColumns({ ...s, n: s.n + 1 })
}

/** Legal columns after which the opponent has no immediate win. */
export function safeColumns(s: FourState): number[] {
  const out: number[] = []
  for (let c = 0; c < COLS; c++) {
    if (!isLegalColumn(s, c)) continue
    const next = drop(s, c)
    if (next.winner !== null || winningColumns(next).length === 0) out.push(c)
  }
  return out
}

/** The move a player who sees one move ahead must make: a win if there is one, else a block of an open threat. Null when neither applies. */
export function forcedMove(s: FourState): number | null {
  const wins = winningColumns(s)
  if (wins.length > 0) return wins[0]!
  const threats = threatColumns(s)
  return threats.length > 0 ? threats[0]! : null
}

export interface VarietyPick {
  /** Candidates must have at least this share of the most visited move's visits. */
  keepShare: number
  /** Candidates must have a mean search value (mover's view, -1 to 1) within this of the most visited move's. */
  valueMargin: number
  /** Candidates are drawn in proportion to visits^(1 / temperature); 1 is plain proportion, higher is flatter. Default 1. */
  temperature?: number
  /** Solver-proven columns: when given, only these are ever played (the near-best ones among them, else the most visited of them). */
  allowed?: ReadonlySet<number>
}

/** Most solver nodes provenKeepers spends: about 0.1 s typical from 12 stones (600k nodes), so this only bites on the slow tail. */
export const SOLVER_MAX_NODES = 2_000_000

/**
 * The columns the weak solver proves keep the game value of a drawn or won position for the side to move, null when the position
 * is lost (every column then has the same value, so there is nothing to vary among), or 'unknown' when the node budget or the
 * deadline (a performance.now() time) ran out first. Solver cost grows steeply with fewer stones: about 0.1 s typical from 12 stones,
 * but some 12 to 13 stone positions take several seconds, so callers use it from there on and must handle 'unknown'.
 */
export function provenKeepers(s: FourState, limits: { maxNodes?: number; deadline?: number } = {}): Set<number> | null | 'unknown' {
  if (s.winner !== null || s.n >= CELLS) return null
  try {
    const r = solve(s, { weak: true, ttBits: 20, maxNodes: limits.maxNodes ?? SOLVER_MAX_NODES, ...(limits.deadline !== undefined ? { deadline: limits.deadline } : {}) })
    return r.score < 0 ? null : new Set(r.bestMoves)
  } catch (e) {
    if (e instanceof SolveLimitError) return 'unknown'
    throw e
  }
}

/**
 * Chooses among near-equal root moves (similar visits and a mean search value within a margin of the top move) in proportion to their visits. A forced win or block is always played, and a move that
 * lets the opponent win at once is never a candidate (unless every near-best move does, which means the position is lost anyway).
 */
export function pickVaried(visits: readonly number[], q: readonly number[], s: FourState, rng: Rng, opts: VarietyPick): number {
  const forced = forcedMove(s)
  if (forced !== null) return forced
  let max = 0
  for (const v of visits) max = Math.max(max, v)
  const safe = new Set(safeColumns(s))
  const top = visits.indexOf(max)
  const near = visits.map((v, c) => (v > 0 && v >= opts.keepShare * max && q[c]! >= q[top]! - opts.valueMargin ? c : -1)).filter((c) => c >= 0)
  const pool = near.filter((c) => safe.has(c) && (!opts.allowed || opts.allowed.has(c)))
  let cands = pool.length > 0 ? pool : near
  if (opts.allowed && pool.length === 0) {
    // No near-best move is proven: play the most visited proven one.
    const proven = [...opts.allowed].filter((c) => visits[c]! > 0)
    if (proven.length > 0) cands = [proven.reduce((a, b) => (visits[b]! > visits[a]! ? b : a))]
    // A starved search can leave every proven column unvisited: still play a proven one, the first (the lowest column), never an unproven near move.
    else if (opts.allowed.size > 0) cands = [Math.min(...opts.allowed)]
  }
  const w = (c: number): number => Math.pow(visits[c]!, 1 / (opts.temperature ?? 1))
  let total = 0
  for (const c of cands) total += w(c)
  let r = rng.float() * total
  for (const c of cands) {
    r -= w(c)
    if (r < 0) return c
  }
  return cands[cands.length - 1]!
}
