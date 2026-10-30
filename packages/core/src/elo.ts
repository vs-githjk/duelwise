import type { Level } from './product'

export function expected(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400))
}

/** New rating for `rating` after one game against `opp`. */
export function update(rating: number, opp: number, score: 0 | 0.5 | 1, k: number): number {
  return rating + k * (score - expected(rating, opp))
}

/** k = 40 for a player's first 10 games, then 24. `gamesPlayed` counts games before this one. */
export function kFor(gamesPlayed: number): number {
  return gamesPlayed < 10 ? 40 : 24
}

const ORDER: Level[] = ['easy', 'medium', 'hard', 'champion']
const SCORE_CLAMP = 0.001

export interface LadderPair {
  lower: Level
  upper: Level
  /** The upper level's score fraction against the lower level (wins plus half draws, over games). */
  score: number
}

/**
 * Site Elo for agent levels: each adjacent pair gives a rating gap 400*log10(s/(1-s)); the
 * anchor level is fixed (Easy = 1000) and the rest follow the chain. A level with no chain of
 * pairs back to the anchor is left out. Gaps are not forced to be positive: a failed level
 * shows up as a lower number rather than being hidden.
 */
export function ladderToElo(pairs: LadderPair[], anchor: { level: Level; elo: number }): Partial<Record<Level, number>> {
  const gap = new Map<number, number>() // index of lower level -> Elo(upper) - Elo(lower)
  for (const p of pairs) {
    const lo = ORDER.indexOf(p.lower)
    if (lo < 0 || ORDER.indexOf(p.upper) !== lo + 1) throw new Error('ladderToElo: pairs must be adjacent levels, got ' + p.lower + ' and ' + p.upper)
    const s = Math.min(1 - SCORE_CLAMP, Math.max(SCORE_CLAMP, p.score))
    gap.set(lo, 400 * Math.log10(s / (1 - s)))
  }
  const out: Partial<Record<Level, number>> = {}
  const ai = ORDER.indexOf(anchor.level)
  out[anchor.level] = anchor.elo
  for (let i = ai; i < ORDER.length - 1 && gap.has(i); i++) out[ORDER[i + 1]!] = out[ORDER[i]!]! + gap.get(i)!
  for (let i = ai - 1; i >= 0 && gap.has(i); i--) out[ORDER[i]!] = out[ORDER[i + 1]!]! - gap.get(i)!
  return out
}
