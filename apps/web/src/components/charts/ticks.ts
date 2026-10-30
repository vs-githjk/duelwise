/**
 * Which x labels to draw so neighbours never touch: every `stride`-th label counted back from the newest point,
 * where stride is the smallest step that leaves at least `minGapPx` between label centres.
 */
export function shownLabelIndexes(n: number, plotWidthPx: number, minGapPx: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [0]
  const gap = plotWidthPx / (n - 1)
  const stride = gap > 0 ? Math.max(1, Math.ceil(minGapPx / gap)) : n
  const out: number[] = []
  for (let i = n - 1; i >= 0; i -= stride) out.unshift(i)
  return out
}
