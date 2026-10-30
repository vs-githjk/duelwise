/**
 * Whether the server can be reached. `navigator.onLine` says only that the device has a network, and some browsers and test tools
 * leave it true when the server is gone, so a quick request to /api/ping settles it. Pure of React; the chip and the upload queue read it.
 */
let unreachable = false
const listeners = new Set<() => void>()

export function setReachable(ok: boolean): void {
  if (unreachable === !ok) return
  unreachable = !ok
  for (const l of [...listeners]) l()
}

/** True when the browser says it is offline or the last probe could not reach the server. */
export function isOffline(): boolean {
  return (typeof navigator !== 'undefined' && navigator.onLine === false) || unreachable
}

export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener)
  if (typeof window === 'undefined') return () => listeners.delete(listener)
  const change = () => { listener(); void probe() }
  window.addEventListener('online', change)
  window.addEventListener('offline', change)
  return () => { listeners.delete(listener); window.removeEventListener('online', change); window.removeEventListener('offline', change) }
}

/** Asks the server for a 204. Updates the state and returns whether it answered. A slow answer counts as no answer (4 s). */
export async function probe(doFetch: typeof fetch = fetch, timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch('/api/ping', { cache: 'no-store', signal: controller.signal })
    setReachable(res.ok)
    return res.ok
  } catch {
    setReachable(false)
    return false
  } finally {
    clearTimeout(timer)
  }
}
