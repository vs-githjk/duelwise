# Offline play (installable app)

Duelwise installs as an app (manifest, icons, iOS meta) and plays with no connection.

## Pieces

- **Service worker** (`apps/web/sw/sw.js`, hand written). The build writes `/sw.js` with the precache list inside
  (`apps/web/scripts/sw-precache.ts`, run from the Nitro `compiled` hook in `vite.config.ts`). It precaches hashed assets,
  fonts, icons, persona art, the onnxruntime wasm, every ONNX model and the game art, plus the server rendered pages
  (`/`, `/play`, each `/play/<game>`). Pages are network first (4 s) with the cached copy as fallback; static files are
  cache first; server calls and uploads are never touched. Caches are named by a hash of the build and old ones are deleted on
  activate. A new worker waits, and the page shows "New version available" with a Reload button; it never reloads by itself.
  It is registered only in production builds.
- **Offline match tickets.** While online the browser keeps a small pool of server-issued tickets per game and level
  (`apps/web/src/lib/tickets.ts`: 5 for levels the player has played, 2 for the others). A ticket is a `match` row with status
  `ticket` (`server/ticket-issue.ts`), made by the same `issueMatchRow` that issues an online match id and seed. The abandon
  sweep and the open-match cap only look at `started` rows, so an unused ticket can never be scored as a loss. Limits: 5 unused
  per game and level, 80 unused in all, 60 issued per hour. Tickets expire after 14 days and are tied to the agent version they
  were issued for. Word Duel has none (its seed never leaves the server).
- **Using a ticket.** No server at the start of a match: the page takes a local ticket (same game and level, issued for the agent
  version this build plays) and plays with its id and seed. The finished record goes to the IndexedDB upload queue. The upload
  (`/api/finish`) turns the ticket into a `started` match once (compare-and-set), then runs the normal replay, agent check and
  rating. Expired: 410. Used: 409. Played against another agent version, or the server has since replaced the agent: stored as
  not counted, with the reason.
- **Upload queue** (`lib/upload-queue.ts`): deduped by match id, doubling backoff, drained on load, on the `online` event every
  30 s, and by the service worker itself when the browser wakes it (Background Sync tag `duelwise-drain`, or a `DRAIN_NOW` message).
- **Word Duel offline** plays on the local word list (`allowed.txt` and the answer list in the bundle) as an unranked match; it
  counts only on the player's own offline record on that device (`lib/offline-record.ts`).
- **Offline states.** A chip says "Offline: matches will sync later". Pages that need the server (leaderboard, report, stats)
  show "You are offline" instead of an error.

## Checking it

`PORT=<free port> bunx playwright test -c playwright.prod.config.ts e2e-prod/pwa-offline.spec.ts --workers=1` builds, serves
the production build with an in-memory database, installs the worker, goes offline, plays Four in a Row, goes online and checks
the queue drains and the public match count rises by one.

## Known limits

- Background Sync exists in Chromium only; elsewhere the queue drains when the app is next open.
- The first visit downloads about 90 MB (all models and game art). Optional files that fail to fetch are cached on first use.
- Cached pages stay on the device until the next version replaces them. Pages with the player's own data (settings, owner,
  sign in, reports) are never cached.
