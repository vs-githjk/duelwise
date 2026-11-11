# Duelwise friend-play relay (M4)

A Cloudflare Worker plus two SQLite-backed Durable Objects (Workers Free plan). It carries two-device friend games for
chess, Four in a Row, Crosscurrent, Twelve Yards, Stormglass and Word Duel. Friend games are never rated, stored in
Neon or trained on; this package never talks to Neon.

## Contract (M5 and M6 build against this)

```
GET wss://<worker>/room/<CODE>?t=<token>        CODE = 6 chars of A-Z, 2-7
GET https://<worker>/health                      200 {"ok":true}
```

Token: `signDuelToken` from `@duelwise/core/src/duel/token` (async, WebCrypto, HMAC-SHA256 with `DUEL_SIGNING_SECRET`).
Payload `{ code, ref, name, exp, host?: { game }, pid?, rt? }`. `ref` is a hashed caller reference, never an email or user id. `pid` is a keyed hash of the person (account when signed in, else browser) for the head-to-head record, and `rt` the public ratings they already have against the AI; both are optional (an older token has neither, and then no result is signed).
A host token (has `host`) creates the room when it does not exist; a guest token (no `host`) only joins an existing
one. The relay accepts any unexpired valid token whose `exp` is at most 24 hours ahead (`LIMITS.maxTokenLifeMs`; later is
HTTP 401), so mint with `exp` of 3 hours at most (the room's life) and mint a new one for a reconnect. A bad, expired or wrong-room token is HTTP 401 before the upgrade. A browser
`Origin` must be duelwise.app, www.duelwise.app or localhost (see `ALLOWED_ORIGINS`); no Origin header is allowed.

Client to server (text JSON, at most 2048 bytes, at most 10 a second):
`{t:'act', a:number, n:number}` (n is `view.n`), `{t:'resign'}`, `{t:'rematch'}`, `{t:'sync'}` (resend my view).
The text `ping` is answered with `pong` without waking the room (use it as a keep-alive).

Server to client: `{t:'view', ...viewFor}` (see `DuelView` in `packages/core/src/duel/room.ts`: obs, legal, canAct,
opponentReady, n, status, result, you, names, connected, seed (null until over), rematch, tally),
`{t:'result', proof}` (sent after the final view of every finished game when both seats came with a `pid`, and again to a seat that reconnects: the game's result signed with `DUEL_SIGNING_SECRET`, see `packages/core/src/duel/result-proof.ts`; it holds the two players, the winner and a per-game id, never moves or the seed; the site verifies it before it writes a head-to-head row),
`{t:'peer', connected:boolean}` (the other seat's socket), `{t:'error', error}` where error is a submit error
(`not-your-turn`, `illegal`, `stale`, `over`, `waiting`), `bad-message` or `not-over`. A view is sent to both seats
after every change and on connect, so a reconnect needs nothing more than opening the socket.

Close codes (`CLOSE` in `src/limits.ts`): 1000 bye (the host cancelled a waiting room), 1009 too big or binary, 4400 bad
game, 4403 room full, 4404 no such room (a guest came before the host, or the room expired), 4408 expired, 4409
replaced (the same person opened another socket), 4410 game over and you are not seated, 4429 too many messages,
4429 also when one person opens more than 10 sockets a minute, 4432 the room spent its games or write budget (calm; start a new link), 4430 too many open rooms (5 per caller), 4431 daily limit (40 creates a day per caller).

Limits (`LIMITS`): wait 30 min for a friend, 3 h lifetime, 20 min idle, exactly 2 seats, 2 KB messages, 10 messages
a second per socket. Sockets are tied to the person (caller `ref`), not the seat, so a rematch that swaps sides keeps every phone on its own view. Storage writes are coalesced (free plan: 100,000 rows written a day for the whole account): a reconnect and a repeated rematch vote write nothing, the room is written at most once a second (alarm-driven flush) and at once when a game ends or a rematch starts, so a crash or eviction can lose at most the last second of moves (the client's next move is answered `stale` plus a fresh view; clients must treat every view as authoritative even if its `n` is lower than the last one they saw). A room may play 30 games (`maxGamesPerRoom`, which also bounds the stored series) and write about 1500 rows (`maxRowsPerRoom`): a rematch that would start past 1500 minus a 300 row reserve closes the room with 4432 (never mid-game); only abuse (2000 rows) closes a game in progress; 40 rooms a day x 2000 stays under the free 100,000 rows. A resolved simultaneous step (Twelve Yards, Word Duel, Stormglass setup) is flushed at once. Measured with two colluding identities at the message limit: 1800 rows a minute before, 89 rows in total before the room closed after (see test/writes.test.ts). The room is deleted from storage when it expires, is cancelled, or the host leaves a waiting room.

## Realtime matches (slice 2, S7)

Tinderbox (`fighter`), Coldstore (`arena`) and Glasscut (`puck`) run as rollback matches through `src/realtime-host.ts`, beside the untouched turn
`RoomHost`. A host token whose game is one of `REALTIME_GAMES` routes the room to the realtime host (sockets get the `rt` tag; a guest or the
alarm asks storage once). The object steps a CONFIRMED copy of the sim only to the last frame both seats have sent, forwards inputs before stepping,
and signs the result its own sim computed (a client `over` or `result` is ignored). Nothing is written per input.

```
client -> {t:'ready', pick?} | {t:'rematch'} | {t:'in', f, c:[codes], hf?, h?} | {t:'need', f, snap?} | {t:'resign'} | {t:'lost'}
server -> {t:'lobby', you, names, ready} | {t:'go', game, seed, you, names, picks, at, have} | {t:'in', s, f, c}
        | {t:'snap', f, state} | {t:'peer', connected} | {t:'over', result|null, void: 'lost'|'cap'|'restart'|'error'|null}
        | {t:'result', proof} | {t:'error', error}
```

`in`: `f` is the first frame the codes apply to (the first message of a seat may start up to 30 frames in; earlier frames hold the idle code), at most 64
codes, each a valid action code of the game; `hf`/`h` is the hash of the client's confirmed state at frame `hf` (a multiple of 60) and a differing one is
answered with `snap` (the relay's state at `hf`, typed arrays as plain arrays: `toWire`/`fromWire` in `packages/core/src/netplay/wire.ts`). `need` asks for
the friend's inputs from a frame (after a reconnect). `go` sent again mid-match to a seat that reconnects carries `at` (the relay's confirmed frame) and `have`
(the first frame it still needs from that seat). Errors: `bad-message`, `bad-start`, `gap`, `ahead`, `not-playing`, `not-silent`, `alone`, and at `ready`
`busy` (D6, the day's estimate is spent), `minutes` (this caller's 60 realtime minutes are spent), `room-limit` (5 matches a room).

Caps (`RT_LIMITS`): 40 messages a second per socket, 512 bytes, a match lasts at most 15 minutes, 5 matches a room, a seat may run at most 120 frames ahead
of the confirmed sim. Void (D7): a seat gone 20 seconds, the 15 minute cap, an object restart mid-match, or `lost` from a client while the friend has been
silent 15 seconds; a void match writes no result and no proof. D6 (`BudgetDO`, one object, one call per match start): realtime may use an estimated 50,000
Durable Object requests a UTC day (half the free plan's 100,000) and each caller 60 realtime minutes a day; a failing counter refuses the match (fails closed).
A seat sending above 31 messages a second since `go` (plus 300) voids the match (`cap`); at match end the requests really used (incoming messages / 20) beyond the estimate charged at `go` are added to the day's counter with one `settle` call. `k` is a keepalive that only keeps the object awake. Both taken at the plan's recommendation, reversible.

## Secrets

The seed is drawn inside the Durable Object from the platform CSPRNG and sent to nobody until the game is over. A seat
receives only `viewFor(room, seat)`. Nothing is logged.

`DUEL_SIGNING_SECRET` signs the room tokens and result proofs and is also the key the site derives every head-to-head player key from (HMAC of the account id or friend device id). Rotating it orphans every stored head-to-head record: old rows stay in the table but no one's new key matches them, so records vanish from the Friends page and account deletion can no longer find them. Do not rotate it without a migration plan.

## Run, test, deploy

- `bun test apps/duel-relay/test/host.test.ts` rules without a runtime (clock, storage and limiter are fakes).
- `bun test apps/duel-relay/test/realtime.test.ts` the realtime rules with a fake clock and store; `realtime-do.test.ts` proves the wiring in workerd.
- `bun test apps/duel-relay/test/room-do.test.ts` starts `wrangler dev --local` (workerd) with a throwaway secret and drives real sockets.
- `deploy.sh` deploys and sets the secret on both sides without printing it. It needs Vidyut's go (D9).
