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

/** Added to every probe so the service worker sends it straight to the network (sw.js strategyFor): a cached copy must never answer it. */
export const PROBE_PARAM = 'dw-probe'

/** The id of the build this page's scripts came from (compiled in by vite.config.ts). Empty where there is none (tests, dev tooling). */
export function pageBuildId(): string {
  try {
    return typeof __DUELWISE_BUILD__ === 'string' ? __DUELWISE_BUILD__ : ''
  } catch {
    return ''
  }
}

function probeUrl(raw: string): string {
  try {
    const u = new URL(raw, typeof location === 'undefined' ? undefined : location.href)
    u.searchParams.set(PROBE_PARAM, String(Date.now()))
    return u.href
  } catch {
    return raw
  }
}

/**
 * Tells a deleted asset from a bad connection by asking the NETWORK (never the worker's cache) about it. No connection or no answer
 * is "offline" (touch nothing). A 404 or an HTML page where a script should be is "stale". Anything else is not ours.
 * Safari does not say which file failed; then the page compares its own build id with the one /sw.js reports now: different means a new
 * deploy went live since this page loaded (stale), the same means the failure is something else (fine).
 */
export async function judgeChunkFailure(
  error: unknown,
  o: { online?: boolean; doFetch?: typeof fetch; buildId?: string } = {},
): Promise<ChunkVerdict> {
  const online = o.online ?? (typeof navigator === 'undefined' ? true : navigator.onLine)
  if (!online) return 'offline'
  const doFetch = o.doFetch ?? fetch
  const named = urlIn(error)
  try {
    if (named) {
      const res = await doFetch(probeUrl(named), { cache: 'no-store' })
      const type = res.headers.get('content-type') ?? ''
      return res.status === 404 || type.includes('text/html') ? 'stale' : 'fine'
    }
    const mine = o.buildId ?? pageBuildId()
    if (!mine) return 'fine'
    const res = await doFetch(probeUrl('/sw.js'), { cache: 'no-store' })
    if (!res.ok) return 'fine'
    const live = /"build"\s*:\s*"([^"]+)"/.exec(await res.text())?.[1]
    return live && live !== mine ? 'stale' : 'fine'
  } catch {
    return 'offline'
  }
}

interface StoreLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem?(k: string): void
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
  o: { store?: StoreLike; now?: () => number; forget?: () => Promise<void>; reload?: () => void; matchActive?: () => boolean; announce?: () => void } = {},
): Promise<boolean> {
  const store = o.store ?? sessionStore()
  const now = (o.now ?? Date.now)()
  const active = o.matchActive ?? isMatchActive
  const announce = o.announce ?? announceUpdate
  // A match is running: never touch the page. The notice tells the player and the end of the match calls this again.
  if (active()) {
    announce()
    return false
  }
  try {
    if (!store) return false
    const last = Number(store.getItem(CHUNK_RELOAD_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false
    store.setItem(CHUNK_RELOAD_KEY, String(now))
  } catch {
    return false
  }
  await (o.forget ?? forgetKeptPages)().catch(() => {})
  // The cache deletes took time: a match may have begun meanwhile. Look again right before the reload, and give the turn back.
  if (active()) {
    try { store.removeItem?.(CHUNK_RELOAD_KEY) } catch { /* the window simply applies */ }
    announce()
    return false
  }
  ;(o.reload ?? (() => window.location.reload()))()
  return true
}

function announceUpdate(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(UPDATE_READY_EVENT))
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
    ;(o.announce ?? announceUpdate)()
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
