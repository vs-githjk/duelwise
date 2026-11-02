import { PRODUCT, type GameId } from '@duelwise/core/src/product'

export interface ChampionFacts {
  version: string
  parent: string | null
  humanMatchesUsed: number
  /** The gate it passed against its parent, when the registry recorded one. */
  gate: { score: number; n: number; ci95: [number, number] } | null
}

const f2 = (v: number) => v.toFixed(2)

/**
 * The words next to the graph. Where a game learns from people it says exactly what the newest version used and beat; where it does not,
 * it says so and names the real sources (self-play and test bots, or a scripted solver for Word Duel and Stormglass). It never says every match trains the AI.
 */
export function learnCopy(i: { game: GameId; learns: boolean; champion: ChampionFacts | null; sinceCount: number; sinceEligible: number }): { title: string; body: string } {
  const name = PRODUCT.games[i.game].displayName
  if (i.game === 'fleet') {
    return {
      title: `${name} is a scripted solver with nothing to train.`,
      body: `${name} is a scripted solver, not a learned model: each level is a different algorithm, so there is nothing to train. Your match is recorded for your report and the board.`,
    }
  }
  if (!i.learns) {
    return {
      title: `${name} trains by self-play and test bots.`,
      body: `${name} trains by self-play and against test bots, not from your matches yet. Your match is recorded for your report and the board.`,
    }
  }
  const c = i.champion
  const shipped = c?.version ? `${c.version} shipped` : 'the last version'
  const n = (v: number) => v.toLocaleString('en-US')
  const since = `${n(i.sinceCount)} finished ${i.sinceCount === 1 ? 'match' : 'matches'} since ${shipped}; ${n(i.sinceEligible)} ${i.sinceEligible === 1 ? 'is' : 'are'} eligible for the next training run (the player allowed training and no check flagged it). Eligible is not the same as used: a run picks from the eligible ones.`
  if (!c || !c.parent) return { title: 'This game can learn from your matches.', body: `No retrained version has shipped yet. ${since}` }
  const trained = c.humanMatchesUsed > 0 ? `${c.version} trained on self-play plus ${c.humanMatchesUsed.toLocaleString('en-US')} finished human matches` : `${c.version} trained on self-play and has not used human matches yet`
  const beat = c.gate ? `, then beat ${c.parent} ${f2(c.gate.score)} over ${c.gate.n.toLocaleString('en-US')} games (likely range ${f2(c.gate.ci95[0])} to ${f2(c.gate.ci95[1])})` : ''
  return { title: 'This game learns from your matches.', body: `${trained}${beat}. ${since}` }
}

export interface Point {
  start: string
  n: number
  wins: number
  /** Win rate 0 to 1, null when nobody played that week. */
  rate: number | null
  /** Under 30 matches: drawn hollow and dashed, because a handful of games says little. */
  thin: boolean
}

export const THIN_UNDER = 30

export function pointsFor(weekly: Array<{ start: string; levels: Partial<Record<string, { games: number; wins: number }>> }>, level: string): Point[] {
  return weekly.map((w) => {
    const t = w.levels[level]
    const n = t?.games ?? 0
    const wins = t?.wins ?? 0
    return { start: w.start, n, wins, rate: n > 0 ? wins / n : null, thin: n < THIN_UNDER }
  })
}

/** The top of the y axis: the next 15 points above the highest rate, never under 30 and never over 100. */
export function axisMax(points: Point[]): number {
  const top = Math.max(0, ...points.map((p) => (p.rate ?? 0) * 100))
  return Math.min(100, Math.max(30, Math.ceil((top + 1) / 15) * 15))
}
