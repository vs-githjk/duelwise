/** What TrainingNotice remembers about the match in progress: which match it is and whether that match began offline (null until the notice first shrinks to its match line). */
export interface BeganOfflineState {
  matchKey: number
  value: boolean | null
}

/**
 * Whether the match began offline, fixed for one match. It is cleared when the notice is not compact (no match yet) and whenever the match
 * changes (a rematch keeps the notice compact, so without the match key an offline start would carry into the next match).
 */
export function trackBeganOffline(prev: BeganOfflineState, input: { compact: boolean; offline: boolean; matchKey: number }): BeganOfflineState {
  const { compact, offline, matchKey } = input
  if (!compact) return { matchKey, value: null }
  if (prev.matchKey !== matchKey || prev.value === null) return { matchKey, value: offline }
  return prev
}

export interface MatchEpoch {
  epoch: number
  hadResult: boolean
  wasActive: boolean
}

/**
 * A counter that moves on when a new match begins in a page that keeps its level: a shown result goes away (Play again in the chess-like games,
 * which hand the result to GameShell), or `matchActive` rises (Coldstore and Tinderbox draw their result panel themselves and only report whether
 * the match is live). A pause or a hidden tab leaves `matchActive` true, so neither counts as a new match.
 */
export function nextMatchEpoch(prev: MatchEpoch, input: { hasResult: boolean; matchActive: boolean }): MatchEpoch {
  const { hasResult, matchActive } = input
  const bump = (prev.hadResult && !hasResult) || (!prev.wasActive && matchActive)
  if (!bump && prev.hadResult === hasResult && prev.wasActive === matchActive) return prev
  return { epoch: bump ? prev.epoch + 1 : prev.epoch, hadResult: hasResult, wasActive: matchActive }
}
