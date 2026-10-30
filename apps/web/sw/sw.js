// Duelwise service worker. Hand written, no dependencies. The build (scripts/sw-precache.ts) replaces the placeholder below with the
// precache list and writes this file to /sw.js. It makes the app open and play with no connection and never touches server calls.
//
// Strategy
//   install   : precache hashed assets, fonts, icons, personas, wasm, models and art, and a few server rendered pages.
//   navigation: network first (4 s), cached copy when the network is out, a calm offline page when there is no copy.
//   static    : cache first (the files are content hashed or versioned by folder), filled on first use when not precached.
//   everything else (server functions, /api, other methods, other origins): not handled, the browser does it.
//   update    : a new worker waits; the page shows "New version available" and tells it to take over (SKIP_WAITING).
'use strict'

const PRECACHE = "__DUELWISE_PRECACHE__"
const PREFIX = 'duelwise-'
const STATIC = PREFIX + 'static-' + PRECACHE.version
const PAGES = PREFIX + 'pages-' + PRECACHE.version
const NAV_TIMEOUT_MS = 4000
const STATIC_PREFIXES = ['/assets/', '/agents/', '/fonts/', '/icons/', '/personas/', '/_resvg/']
// Pages that carry the player's own data are never kept.
const PRIVATE_PREFIXES = ['/api/', '/owner', '/settings', '/signin', '/report', '/report-card']

/** How a request is handled: 'navigate', 'static' or 'pass' (leave it to the browser). Pure, so it can be tested. */
function strategyFor(url, method, mode, origin) {
  if (method !== 'GET') return 'pass'
  if (url.origin !== origin) return 'pass'
  const path = url.pathname
  if (path === '/sw.js' || path.startsWith('/_serverFn') || path.startsWith('/api/')) return 'pass'
  if (mode === 'navigate') return PRIVATE_PREFIXES.some((p) => path.startsWith(p)) ? 'navigate-private' : 'navigate'
  if (path === '/manifest.webmanifest' || STATIC_PREFIXES.some((p) => path.startsWith(p))) return 'static'
  return 'pass'
}

const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline | Duelwise</title>' +
  '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;min-height:100dvh;place-items:center;background:#fff8ee;color:#2a2118}main{max-width:26rem;padding:1.5rem}' +
  'a{display:inline-block;margin-top:.75rem;padding:.7rem 1.1rem;border-radius:.6rem;background:#2b6fe6;color:#fff;text-decoration:none;font-weight:600}</style></head>' +
  '<body><main><h1>You are offline</h1><p>This page is not saved on this device yet. Games you have opened before still work, and finished matches are kept and sent when you are back online.</p>' +
  '<a href="/play">Back to games</a></main></body></html>'

async function fetchIntoCache(cache, url, credentials) {
  const res = await fetch(url, { cache: 'reload', credentials: credentials || 'same-origin' })
  if (!res.ok) throw new Error(url + ' ' + res.status)
  await cache.put(url, res)
}

/** Runs `worker` over `items`, a few at a time. */
async function pool(items, size, worker) {
  const queue = items.slice()
  const errors = []
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift()
        try {
          await worker(item)
        } catch (e) {
          errors.push(e)
        }
      }
    }),
  )
  return errors
}

async function install() {
  const statics = await caches.open(STATIC)
  const pages = await caches.open(PAGES)
  const missing = await pool(PRECACHE.required, 6, (u) => fetchIntoCache(statics, u))
  if (missing.length) throw new Error('precache failed for ' + missing.length + ' required files: ' + missing[0].message)
  // Best effort from here: a failed model or page is cached on first use instead.
  // Without cookies: the pages kept at install must carry no player's name or email (the page loader puts the signed-in player in the HTML).
  await pool(PRECACHE.pages, 3, (u) => fetchIntoCache(pages, u, 'omit'))
  await pool(PRECACHE.optional, 4, (u) => fetchIntoCache(statics, u))
}

async function activate() {
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && name !== STATIC && name !== PAGES) await caches.delete(name)
  }
  await self.clients.claim()
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function navigate(request, keep) {
  const pages = await caches.open(PAGES)
  try {
    const res = await withTimeout(fetch(request), NAV_TIMEOUT_MS)
    if (keep && res.ok && !res.redirected && res.type === 'basic') pages.put(request, res.clone()).catch(() => {})
    return res
  } catch {
    const hit = await pages.match(request, { ignoreSearch: true, ignoreVary: true })
    return hit || new Response(OFFLINE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}

async function staticFirst(request) {
  const statics = await caches.open(STATIC)
  // ignoreVary: files cached at install were fetched with other request headers than the page sends.
  const hit = await statics.match(request, { ignoreVary: true })
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok && res.status === 200) statics.put(request, res.clone()).catch(() => {})
  return res
}

self.addEventListener('install', (event) => event.waitUntil(install()))
self.addEventListener('activate', (event) => event.waitUntil(activate()))
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
  if (event.data && event.data.type === 'DRAIN_NOW') event.waitUntil(drainQueue(Date.now()))
  if (event.data && event.data.type === 'VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: PRECACHE.version })
})
self.addEventListener('fetch', (event) => {
  const request = event.request
  const how = strategyFor(new URL(request.url), request.method, request.mode, self.location.origin)
  if (how === 'navigate') event.respondWith(navigate(request, true))
  else if (how === 'navigate-private') event.respondWith(navigate(request, false))
  else if (how === 'static') event.respondWith(staticFirst(request))
})
// Wake drain. A finished offline match waits in IndexedDB ('duelwise-offline', store 'uploads', written by lib/upload-queue.ts).
// When the connection returns the browser wakes this worker (Background Sync, where it exists), or a page asks with DRAIN_NOW, and the
// worker posts the records itself, so they are sent even when no page is open. The rules are the same as the page's drainUploads:
// an answer below 500 other than 401, 403 and 429 settles the record; anything else keeps it with a doubling delay.
const DB_NAME = 'duelwise-offline'
const DB_VERSION = 3
const MAX_BACKOFF_MS = 60 * 60 * 1000

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('uploads')) db.createObjectStore('uploads', { keyPath: 'matchId' })
      if (!db.objectStoreNames.contains('tickets')) db.createObjectStore('tickets', { keyPath: 'matchId' })
      if (!db.objectStoreNames.contains('consumed')) db.createObjectStore('consumed', { keyPath: 'matchId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('uploads', mode)
    const req = fn(tx.objectStore('uploads'))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
const REFUSED_KEEP_MS = 16 * 24 * 60 * 60 * 1000
const settles = (status, item, now) =>
  (status >= 200 && status < 500 && status !== 401 && status !== 403 && status !== 429) ||
  // "Not your match" is kept for a while (the right player may sign back in), then dropped: its ticket could not count any more.
  (status === 403 && typeof item.createdAt === 'number' && now - item.createdAt > REFUSED_KEEP_MS)
function why(status, answer) {
  if (status === 410) return 'its offline slot expired before it was sent'
  if (status === 409) return answer.reason ? 'the server already settled it (' + answer.reason + ')' : 'the server already has a result for it'
  if (status === 404) return 'the server has no record of this match'
  if (status === 403) return 'it was played by another player on this device'
  return answer.reason || 'the server did not accept it'
}

let draining = null
function drainQueue(now) {
  if (draining) return draining
  draining = (async () => {
    const outcomes = []
    const db = await openQueue()
    try {
      for (const item of await run(db, 'readonly', (s) => s.getAll())) {
        if (item.nextAttempt > now) continue
        let status = 0
        let answer = {}
        try {
          const res = await fetch('/api/finish', { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: item.bytes, credentials: 'same-origin' })
          status = res.status
          try {
            const body = await res.json()
            if (typeof body.valid === 'boolean') answer.valid = body.valid
            answer.reason = typeof body.reason === 'string' ? body.reason : typeof body.error === 'string' ? body.error : undefined
          } catch {
            // no JSON body
          }
        } catch {
          // still offline: keep it
        }
        if (settles(status, item, now)) {
          await run(db, 'readwrite', (s) => s.delete(item.matchId))
          const counted = status === 200 ? answer.valid !== false : status === 409 && answer.valid === true
          outcomes.push({ matchId: item.matchId, counted, reason: counted ? undefined : status === 200 ? answer.reason || 'the server could not verify it' : why(status, answer) })
        } else {
          const attempts = item.attempts + 1
          await run(db, 'readwrite', (s) => s.put({ ...item, attempts, nextAttempt: now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 12)) }))
        }
      }
    } finally {
      db.close()
    }
    if (outcomes.length) {
      for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'QUEUE_SETTLED', matchIds: outcomes.map((o) => o.matchId), outcomes })
    }
    return outcomes.length
  })().finally(() => { draining = null })
  return draining
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'duelwise-drain') event.waitUntil(drainQueue(Date.now()))
})
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'duelwise-drain') event.waitUntil(drainQueue(Date.now()))
})
