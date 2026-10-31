/**
 * A new deploy renames every hashed script. A tab opened before it, or a page served from an older copy, can then ask for a chunk
 * that is gone (the server answers 404 with an HTML page). That is not "offline" and a retry in place cannot fix it; one fresh load
 * of the page can. This module recognises the failure, checks it really is a stale asset (not the connection, not a bug inside the
 * module), and reloads once, never in a loop, never in the middle of a match, never when it cannot remember that it already did.
 */
import { isMatchActive } from './match-active'

export const CHUNK_RELOAD_KEY = 'duelwise.chunk-reload'
/** A second chunk failure inside this window means the reload did not help: show the error instead of reloading again. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000
/** Fired on window when a stale deploy was found while a match is running; the update notice listens. */
export const UPDATE_READY_EVENT = 'duelwise:update-ready'

// Words the browsers use when a script or style could not be fetched or imported. A module that loaded and then threw is not here.
const FETCH_WORDS = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css|failed to load module script|expected a javascript[- ]module/i

function messageOf(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : typeof (error as { message?: unknown } | null)?.message === 'string' ? (error as { message: string }).message : ''
}

/** The first http(s) URL in a message, e.g. the module a browser says it could not fetch. */
export function urlIn(error: unknown): string | null {
  const message = messageOf(error)
  const absolute = /https?:\/\/[^\s"')]+/.exec(message)?.[0]
  if (absolute) return absolute
  // Vite words a failed stylesheet preload with the site-relative path.
  const relative = /(\/assets\/[^\s"')]+)/.exec(message)?.[1]
  if (relative && typeof location !== 'undefined') return new URL(relative, location.origin).href
  return null
}

function devBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
}

/**
 * True when an error (or rejection reason) is a failure to FETCH or import a script or style of this site. A module that loaded and
 * then threw while running is a real bug and is not one. A message that names a URL counts only for this site's /assets files
 * (the dev server serves source files instead, so any path of this site counts there).
 */
export function isChunkError(error: unknown, origin: string | undefined = typeof location === 'undefined' ? undefined : location.origin): boolean {
  const message = messageOf(error)
  if (!FETCH_WORDS.test(message)) return false
  const raw = urlIn(error)
  if (!raw) return true
  try {
    const url = new URL(raw)
    if (origin && url.origin !== origin) return false
    return url.pathname.startsWith('/assets/') || devBuild()
  } catch {
    return false
  }
}

export type ChunkVerdict = 'stale' | 'offline' | 'fine'

/**
 * Tells a deleted asset from a bad connection by asking the network for the failing file. No connection or no answer is
 * "offline" (touch nothing). A 404 or an HTML page where a script should be is "stale". Anything else (the file is fine) is not ours.
 * With no URL in the error (Safari), the page's own module scripts stand in; with none of those either, do nothing.
 */
export async function judgeChunkFailure(
  error: unknown,
  o: { online?: boolean; doFetch?: typeof fetch; knownAssets?: () => string[] } = {},
): Promise<ChunkVerdict> {
  const online = o.online ?? (typeof navigator === 'undefined' ? true : navigator.onLine)
  if (!online) return 'offline'
  const named = urlIn(error)
  const urls = named ? [named] : (o.knownAssets ?? pageModuleUrls)()
  if (urls.length === 0) return 'fine'
  const doFetch = o.doFetch ?? fetch
  let stale = false
  for (const url of urls) {
    try {
      const res = await doFetch(url, { cache: 'no-store' })
      const type = res.headers.get('content-type') ?? ''
      if (res.status === 404 || type.includes('text/html')) stale = true
    } catch {
      return 'offline'
    }
  }
  return stale ? 'stale' : 'fine'
}

/** The page's own module scripts and preloads (at most 6): safari words a failed import without saying which file, so these stand in. */
function pageModuleUrls(): string[] {
  try {
    if (typeof document === 'undefined') return []
    const found = [...document.querySelectorAll('script[type="module"][src], link[rel="modulepreload"][href]')]
      .map((el) => (el as HTMLScriptElement).src || (el as HTMLLinkElement).href)
      .filter(Boolean)
    return [...new Set(found)].slice(0, 6)
  } catch {
    return []
  }
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
 * Reloads the page once for a stale chunk. Returns false (and does nothing) when it already did so a moment ago, or when it cannot
 * remember that it did (unreadable or unwritable storage, e.g. Safari private mode): then a reload could loop, so the player is asked instead.
 */
export async function reloadForStaleChunk(
  o: { store?: StoreLike; now?: () => number; forget?: () => Promise<void>; reload?: () => void } = {},
): Promise<boolean> {
  const store = o.store ?? sessionStore()
  const now = (o.now ?? Date.now)()
  try {
    if (!store) return false
    const last = Number(store.getItem(CHUNK_RELOAD_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false
    store.setItem(CHUNK_RELOAD_KEY, String(now))
  } catch {
    return false
  }
  await (o.forget ?? forgetKeptPages)().catch(() => {})
  ;(o.reload ?? (() => window.location.reload()))()
  return true
}

export type Recovery = 'ignored' | 'offline' | 'fine' | 'reloaded' | 'deferred' | 'ask'

/**
 * What to do about one failure. Only a chunk-fetch failure that the network confirms is stale does anything, and then:
 * during a match it only announces the update ('deferred'); otherwise it reloads once ('reloaded') or, when it may not, says to ask the player ('ask').
 */
export async function recoverFromChunkError(
  error: unknown,
  o: { judge?: typeof judgeChunkFailure; matchActive?: () => boolean; reload?: typeof reloadForStaleChunk; announce?: () => void } = {},
): Promise<Recovery> {
  if (!isChunkError(error)) return 'ignored'
  const verdict = await (o.judge ?? judgeChunkFailure)(error)
  if (verdict !== 'stale') return verdict
  if ((o.matchActive ?? isMatchActive)()) {
    ;(o.announce ?? (() => typeof window !== 'undefined' && window.dispatchEvent(new Event(UPDATE_READY_EVENT))))()
    return 'deferred'
  }
  return (await (o.reload ?? reloadForStaleChunk)()) ? 'reloaded' : 'ask'
}

let installed = false

/** Browser only. Listens for Vite's preload failure and for dynamic imports that reject, and runs the recovery above. */
export function installStaleChunkGuard(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  let busy = false
  const run = (error: unknown) => {
    if (busy || !isChunkError(error)) return
    busy = true
    void recoverFromChunkError(error).finally(() => { busy = false })
  }
  // Not prevented: when no reload happens the failure must still reach the error screen.
  window.addEventListener('vite:preloadError', (event) => run((event as Event & { payload?: unknown }).payload))
  window.addEventListener('unhandledrejection', (event) => run(event.reason))
}
