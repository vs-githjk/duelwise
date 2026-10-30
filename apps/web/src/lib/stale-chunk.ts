/**
 * A new deploy renames every hashed script. A tab opened before it, or a page served from an older copy, can then ask for a chunk
 * that is gone (the server answers 404 with an HTML page). That is not "offline" and a retry in place cannot fix it; one fresh
 * load of the page can. This module recognises the failure and does that reload once, never in a loop.
 */

export const CHUNK_RELOAD_KEY = 'duelwise.chunk-reload'
/** A second chunk failure inside this window means the reload did not help: show the error instead of reloading again. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000

const CHUNK_WORDS = /dynamically imported module|importing a module script failed|error loading dynamically|unable to preload css|failed to load module script|expected a javascript[- ]module/i

/** True when an error (or a rejection reason) means a script or style chunk of this site could not be loaded. */
export function isChunkError(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : typeof (error as { message?: unknown } | null)?.message === 'string' ? (error as { message: string }).message : ''
  return CHUNK_WORDS.test(message)
}

interface StoreLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

function sessionStore(): StoreLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/** Drops the page copies the service worker keeps, so the next load goes to the network for the newest page. Never throws. */
export async function forgetKeptPages(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    for (const name of await caches.keys()) if (name.startsWith('duelwise-pages-')) await caches.delete(name)
  } catch {
    // No Cache Storage: the reload still goes to the network for a page it has no copy of.
  }
}

/**
 * Reloads the page once for a stale chunk. Returns false (and does nothing) when it already did so a moment ago, so a chunk that is
 * really missing ends in the error screen rather than a reload loop. Unreadable storage counts as "not yet reloaded" for the first try.
 */
export async function reloadForStaleChunk(
  o: { store?: StoreLike; now?: () => number; forget?: () => Promise<void>; reload?: () => void } = {},
): Promise<boolean> {
  const store = o.store ?? sessionStore()
  const now = (o.now ?? Date.now)()
  try {
    const last = Number(store?.getItem(CHUNK_RELOAD_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false
  } catch {
    // Blocked storage: allow this one reload; the in-memory guard in the caller stops repeats within a page.
  }
  try {
    store?.setItem(CHUNK_RELOAD_KEY, String(now))
  } catch {
    // Same: nothing to remember it in.
  }
  await (o.forget ?? forgetKeptPages)().catch(() => {})
  ;(o.reload ?? (() => window.location.reload()))()
  return true
}

let installed = false

/** Browser only. Listens for Vite's preload failure and for dynamic imports that reject, and reloads once for either. */
export function installStaleChunkGuard(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  let tried = false
  const recover = () => {
    if (tried) return
    tried = true
    void reloadForStaleChunk().then((did) => { if (!did) tried = false })
  }
  // Not prevented: when the reload is refused the failure must still reach the error screen.
  window.addEventListener('vite:preloadError', recover)
  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkError(event.reason)) recover()
  })
}
