/**
 * Runs a page's data load and turns a failure into `{ unavailable: true }`, so the page can say so calmly instead of
 * throwing to the error page. A connection problem on the visitor's side (offline) still rethrows: it has its own screen.
 */
export async function orUnavailable<T>(load: () => Promise<T>, isOffline: (e: unknown) => boolean): Promise<T | { unavailable: true }> {
  try {
    return await load()
  } catch (e) {
    if (isOffline(e)) throw e
    return { unavailable: true }
  }
}
