/** Refresh a writing report until its view changes or the page is left. */
export function pollWritingReport(invalidate: () => void, intervalMs = 2000): () => void {
  const timer = setInterval(invalidate, intervalMs)
  return () => clearInterval(timer)
}
