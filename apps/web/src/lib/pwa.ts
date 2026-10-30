import { QUEUE_EVENT, type UploadOutcome } from './upload-queue'

/** Asks the browser to wake the service worker when the connection returns, so queued records are sent even with the app closed. */
export function requestWakeDrain(): void {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    void navigator.serviceWorker.ready
      .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register('duelwise-drain'))
      .catch(() => {})
  } catch {
    // No Background Sync (Safari, Firefox): the page drains on load and on the online event instead.
  }
}

/** What a worker message means to a page. Pure so it can be tested. */
export type WorkerMessage = { type: 'QUEUE_SETTLED'; matchIds: string[]; outcomes?: UploadOutcome[] } | { type: 'DRAIN' } | { type: 'VERSION'; version: string }
export function onWorkerMessage(data: unknown, dispatch: (event: Event) => void, drain: () => void): void {
  const m = data as Partial<WorkerMessage> | null
  if (!m || typeof m !== 'object') return
  if (m.type === 'QUEUE_SETTLED' && Array.isArray(m.matchIds)) dispatch(new CustomEvent(QUEUE_EVENT, { detail: { matchIds: m.matchIds, outcomes: Array.isArray(m.outcomes) ? m.outcomes : m.matchIds.map((matchId) => ({ matchId, counted: true })) } }))
  else if (m.type === 'DRAIN') drain()
}

/**
 * Sign-out on a shared device: drops everything kept for the person who left. The cached pages carry the signed-in player's name
 * and email (the root loader puts the viewer in the HTML), and the unused offline tickets belong to them. Finished records still
 * waiting to upload stay: they are the player's matches and are sent once they are back. Never throws.
 */
export async function forgetPrivateData(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') for (const name of await caches.keys()) if (name.startsWith('duelwise-pages-')) await caches.delete(name)
  } catch { /* no Cache Storage */ }
  const { forgetTickets } = await import('./tickets')
  await forgetTickets()
}
