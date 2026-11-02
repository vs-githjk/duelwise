/** Client side of rated-match integrity: telling the server a counted match was given up. */

export const RESIGN_URL = '/api/resign'

export interface ResignReply {
  resigned: true
  unplayed?: boolean
  elo?: { before: number; after: number }
  provisional?: boolean
}

/** The Resign button: waits for the server's answer so the page can show the rating change. */
export async function postResign(matchId: string, tick: number, doFetch: typeof fetch = fetch): Promise<ResignReply> {
  const res = await doFetch(RESIGN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ matchId, tick }),
    credentials: 'same-origin',
  })
  const body = (await res.json().catch(() => ({}))) as Partial<ResignReply> & { error?: string }
  if (!res.ok || body.resigned !== true) throw new Error(body.error ?? 'The server could not record the resignation.')
  return body as ResignReply
}

/**
 * The tab is going away mid-match: queue the resignation with the browser, which delivers it even
 * after the page is gone. Returns false when the browser has no beacon support or refuses the call.
 */
export function beaconResign(matchId: string, tick: number, nav: Pick<Navigator, 'sendBeacon'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav || typeof nav.sendBeacon !== 'function') return false
  try {
    return nav.sendBeacon(RESIGN_URL, new Blob([JSON.stringify({ matchId, tick })], { type: 'text/plain' }))
  } catch {
    return false
  }
}

export const RESIGNED_KEY = 'duelwise.resigned-on-leave'

/**
 * The page is going away (reload, close, bfcache) with a counted match running: send the resignation and, only when the
 * browser took it, leave a note for the next page load so the player is told why they are back on setup.
 */
export function resignOnPageLeave(game: string, matchId: string, tick: number, nav?: Pick<Navigator, 'sendBeacon'>, store: Pick<KeyValueStore, 'setItem'> | undefined = defaultStore(), practice = false): boolean {
  const sent = nav === undefined ? beaconResign(matchId, tick) : beaconResign(matchId, tick, nav)
  // A practice match costs nothing to leave, so there is nothing to explain.
  if (!sent || practice) return sent
  try {
    store?.setItem(RESIGNED_KEY, JSON.stringify({ game, matchId }))
  } catch {}
  return true
}

/** Whether the last match of this game was resigned by a page leave and the player has not started another since. */
export function readResignedOnLeave(game: string, store: Pick<KeyValueStore, 'getItem'> | undefined = defaultStore()): boolean {
  try {
    const raw = store?.getItem(RESIGNED_KEY)
    return raw ? (JSON.parse(raw) as { game?: unknown }).game === game : false
  } catch {
    return false
  }
}

/** The page came back from the back-forward cache with its match still on screen: nothing was lost for the player to be told about. */
export function clearResignedOnRestore(persisted: boolean, store?: Pick<KeyValueStore, 'removeItem'>): void {
  if (persisted) clearResignedOnLeave(store ?? defaultStore())
}

/** Dropped when the next match starts. */
export function clearResignedOnLeave(store: Pick<KeyValueStore, 'removeItem'> | undefined = defaultStore()): void {
  try {
    store?.removeItem(RESIGNED_KEY)
  } catch {}
}

export const FINISH_URL = '/api/finish'
const PENDING_PREFIX = 'duelwise.pending-finish.'

/** The slice of Storage the pending-finish store uses, so tests can pass a fake. */
export interface KeyValueStore {
  readonly length: number
  key(i: number): string | null
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

function defaultStore(): KeyValueStore | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/**
 * A finished counted match whose record the server has not acknowledged. Kept so the next page load can
 * deliver it before the abandon window closes: a finished match must never be left 'started', because
 * the abandon rule scores that as a loss.
 */
export function savePending(matchId: string, bytes: Uint8Array, store: KeyValueStore | undefined = defaultStore()): void {
  try {
    store?.setItem(PENDING_PREFIX + matchId, toBase64(bytes))
  } catch {
    // Storage full or blocked: the beacon and the in-page retry still cover the common cases.
  }
}

export function clearPending(matchId: string, store: KeyValueStore | undefined = defaultStore()): void {
  try {
    store?.removeItem(PENDING_PREFIX + matchId)
  } catch {
    // Nothing to clear if storage is blocked.
  }
}

export function listPending(store: KeyValueStore | undefined = defaultStore()): Array<{ matchId: string; bytes: Uint8Array }> {
  const out: Array<{ matchId: string; bytes: Uint8Array }> = []
  try {
    if (!store) return out
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (!k || !k.startsWith(PENDING_PREFIX)) continue
      const v = store.getItem(k)
      if (v) out.push({ matchId: k.slice(PENDING_PREFIX.length), bytes: fromBase64(v) })
    }
  } catch {
    // Unreadable storage: nothing to retry.
  }
  return out
}

/** Posts a gzip record to the plain finish route and returns the HTTP status. */
export async function postFinish(bytes: Uint8Array, doFetch: typeof fetch = fetch): Promise<number> {
  const res = await doFetch(FINISH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip' },
    body: bytes as BodyInit,
    credentials: 'same-origin',
  })
  return res.status
}

/** What the finish route said about a record: the HTTP status, and for a 200 whether the match was valid and why not. */
export interface FinishAnswer { status: number; valid?: boolean; reason?: string }

/** Like postFinish, but also reads the answer body, so a caller can tell a counted match from one the server refused. */
export async function postFinishDetailed(bytes: Uint8Array, doFetch: typeof fetch = fetch): Promise<FinishAnswer> {
  const res = await doFetch(FINISH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/gzip' },
    body: bytes as BodyInit,
    credentials: 'same-origin',
  })
  const answer: FinishAnswer = { status: res.status }
  try {
    const body = (await res.json()) as { valid?: unknown; reason?: unknown; error?: unknown }
    if (typeof body.valid === 'boolean') answer.valid = body.valid
    if (typeof body.reason === 'string') answer.reason = body.reason
    else if (typeof body.error === 'string') answer.reason = body.error
  } catch { /* no JSON body */ }
  return answer
}

/** The tab is going away with a record the server has not acknowledged: queue it with the browser. */
export function beaconFinish(bytes: Uint8Array, nav: Pick<Navigator, 'sendBeacon'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav || typeof nav.sendBeacon !== 'function') return false
  try {
    return nav.sendBeacon(FINISH_URL, new Blob([bytes as BlobPart], { type: 'application/gzip' }))
  } catch {
    return false
  }
}

/**
 * On page load: delivers records left over from an earlier page. Any answer below 500 settles the
 * match on the server (finished, or already settled), so the entry is dropped; a network error or a
 * 5xx keeps it for the next load.
 */
export async function retryPending(store: KeyValueStore | undefined = defaultStore(), doFetch: typeof fetch = fetch): Promise<number> {
  let settled = 0
  for (const p of listPending(store)) {
    try {
      const status = await postFinish(p.bytes, doFetch)
      if (status < 500) {
        clearPending(p.matchId, store)
        settled++
      }
    } catch {
      // Still offline: try again on the next load.
    }
  }
  return settled
}
