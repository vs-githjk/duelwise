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

/** A counter that moves on when a finished match goes away (Play again): result shown, then not shown. */
export function nextMatchEpoch(prev: { epoch: number; hadResult: boolean }, hasResult: boolean): { epoch: number; hadResult: boolean } {
  if (prev.hadResult && !hasResult) return { epoch: prev.epoch + 1, hadResult: false }
  return prev.hadResult === hasResult ? prev : { epoch: prev.epoch, hadResult: hasResult }
}
