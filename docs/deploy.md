# Deploy: Vercel, Neon and sign-in

Everything here is done by you, in your own accounts. Agents never open these consoles. Each step says what to copy and where to paste it. Variable names and comments are in `.env.example`.

What you need: a Vercel account (Hobby is enough), a Neon account, a Google Cloud project, a GitHub account, optionally a Sentry account. All have free tiers.

Status of this guide: the repo side was checked (`bun run smoke` passes on a production build). The Vercel, Neon, Google and GitHub console steps have not been run by an agent; the first real deploy is their test. Where a step depends on something I could not check, it says so.

## 0. Before you start

1. Run the suite on the branch you will deploy (see `docs/morning-checklist.md`).
2. Pick the site name. Vercel gives every project a `<project-name>.vercel.app` address. Decide the project name first so you know the final origin for the sign-in callbacks below. Write it down as `SITE`, for example `https://duelwise.vercel.app` (no trailing slash).
3. Hobby projects cannot import a repository owned by a Git organisation (VERIFIED in the Vercel docs). Keep the repository private under your own user account.

## 1. Neon database

1. Create a Neon project. Pick the region closest to the Vercel function region you will use (US East on both is the simplest).
2. Open the project dashboard, click Connect, and tick "Connection pooling". Copy the connection string. Its host contains `-pooler`. This is `DATABASE_URL`.
3. Also copy the direct (unpooled) string, untick pooling. You use it only for the migration below.
4. Apply the migrations yourself, in order, once. Open the Neon SQL Editor and paste `apps/web/drizzle/0000_init.sql`, run it, then paste `apps/web/drizzle/0001_auth.sql` and run it, then `apps/web/drizzle/0002_telemetry.sql` (the telemetry and owner audit tables), then `apps/web/drizzle/0003_report.sql` (the match report table), then `apps/web/drizzle/0004_leaderboard_privacy.sql` (the "Show me on the leaderboard" switch; it adds one column with a default, so existing players stay listed). Or from a terminal at the repository root:

   ```
   psql "<direct connection string>" -f apps/web/drizzle/0000_init.sql
   psql "<direct connection string>" -f apps/web/drizzle/0001_auth.sql
   psql "<direct connection string>" -f apps/web/drizzle/0002_telemetry.sql
   psql "<direct connection string>" -f apps/web/drizzle/0003_report.sql
   psql "<direct connection string>" -f apps/web/drizzle/0004_leaderboard_privacy.sql
   ```

   The app never migrates Neon itself, and a Vercel build does not either. A new file in `apps/web/drizzle/` later means one more manual run, in file order.
5. Check: `select table_name from information_schema.tables where table_schema = 'public' order by 1;` lists `account`, `agent_version`, `guest`, `match`, `match_report`, `profile`, `rating`, `session`, `owner_audit`, `telemetry_event`, `training_run`, `user` and `verification`.

## 2. Vercel project

1. Push the branch you want live to your private GitHub repository. (Pushing is your call; the build agents never push.)
2. In Vercel: Add New, Project, import the repository.
3. Project settings before the first deploy:
   - Framework preset: Other (the build output comes from Nitro, which detects Vercel on its own).
   - Root Directory: `apps/web`, with "Include source files outside of the Root Directory in the Build Step" switched on. The web app imports the workspace packages in `packages/`, so they must be in the build. (Not tested by an agent. If the install fails to find `bun.lock`, set Root Directory to the repository root and the build command to `bun run --cwd apps/web build`; whether the Nitro output is then picked up is unverified.)
   - Install command: `bun install`. Build command: `bun run build`.
   - `apps/web/vercel.json` already sets `"bunVersion": "1.x"`.
4. Do not deploy yet. Add the environment variables first (section 5), because the sign-in callbacks need `SITE`.

Limits that matter on Hobby: request bodies are capped at 4.5 MB (the match upload endpoint answers 413 before that), and `apps/web/public` must stay under the 150 MB budget in the plan.

### Public repository and previews

- The repository is meant to be public. The history and working tree were checked for keys and tokens (security pass R37); keep every secret in Vercel's environment variables, never in a file. `.vercel/` is in `.gitignore` so the CLI's project link is never committed.
- Keep Vercel's Standard Deployment Protection switched on for preview deployments (Project Settings, Deployment Protection). Only production should be open to everyone. Previews of a public repository can run code from a pull request.
- `BETTER_AUTH_URL` must be set on every deployment that serves players. The share card, the guest cookie's Secure flag, the cross-site check on `/api/finish` and `/api/resign` and the server's copy of the opponent (below) all read it, and none of them falls back to the address the request claims to come from.

### What the server checks when a match ends

Chess, Four in a Row and Hold'em: when a match is uploaded the server replays the record and then re-runs the opponent on its own, move by move, with the same agent code and the seed it issued. One opponent move that differs and the match is not counted: no rating, not used for training, record not stored. The opponent's model files are read from the build when they are there, otherwise fetched from `BETTER_AUTH_URL` (they are public static files, so Deployment Protection must not cover the production domain). The check stops after 12 seconds (30 seconds for the Four in a Row Champion, 45 seconds for the chess Champion) and then leaves the match uncounted (never valid). Set the function's maximum duration in the Vercel project settings to 60 seconds, or the platform may cut the request first (not verified by an agent). Measured on an M2 at load 1.5 to 2.6: a whole game against Easy to Hard takes about 0.1 to 1 s, but a whole Four Champion game takes about 10 to 11 s for 19 to 21 agent moves (11305, 10957, 10140 and 11269 ms in four runs). A host 20 percent slower than that M2 would have run out of the old 12 s, which is why the Champion has 30 s. Nobody has measured it on Vercel yet; watch the `agent check` log lines and the share of Four Champion matches that end 'ran out of time'. A check is also claimed per match: a second upload of the same match while one runs answers 503 (so the browser keeps the record and retries it), and a check that died can be retried after 75 seconds.

- The chess Champion searches a fixed 129,500 nodes a move (no clock), so the server reproduces every move and its matches count. A Champion game takes the server about one second per Champion move; one that cannot finish inside 45 seconds is not counted, so set the Vercel function `maxDuration` to 60. The Four in a Row Champion is re-run with its full 800 simulations; a player whose device was cut short by the 1.4 s cap will see the match uncounted.
- The fighter and the arena shooter do not change a rating or the leaderboard at all until the same check exists for them. Their pages say so.
- Each player may have 3 matches open at once; starting a fourth settles the oldest as abandoned.

## 3. Google sign-in

1. Google Cloud Console, pick or create a project, APIs and Services, OAuth consent screen. Fill the app name, support email and developer contact. Publishing status "Testing" works for you and the test users you add; "In production" is needed for anyone else.
2. Credentials, Create credentials, OAuth client ID, type Web application.
3. Authorized JavaScript origins: `SITE`.
4. Authorized redirect URIs: `SITE/api/auth/callback/google`.
5. Copy the client ID to `GOOGLE_CLIENT_ID` and the secret to `GOOGLE_CLIENT_SECRET`.

If you leave both empty the Google button is hidden.

## 4. GitHub sign-in

1. GitHub, Settings, Developer settings, OAuth Apps, New OAuth App.
2. Homepage URL: `SITE`. Authorization callback URL: `SITE/api/auth/callback/github`.
3. Generate a client secret. Copy the client ID to `GITHUB_CLIENT_ID` and the secret to `GITHUB_CLIENT_SECRET`.

If you leave both empty the GitHub button is hidden. One OAuth app has one callback URL, so Vercel preview deployments (which have other addresses) cannot sign in with it; that is why the variables below are set for Production only.

## 5. Environment variables

Vercel project, Settings, Environment Variables. Scope: Production only for all of them.

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | the pooled Neon string | Without it the app falls back to an embedded database that does not survive on Vercel. |
| `BETTER_AUTH_SECRET` | output of `openssl rand -base64 32` | Generate it once, paste it, keep no copy in files. |
| `BETTER_AUTH_URL` | `SITE` | No trailing slash. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from section 3 | Optional. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from section 4 | Optional. |
| `OWNER_EMAILS` | your own user id (best), or your sign-in email, or several separated by commas | Who may open `/owner`, the observability page. Anyone else, and everyone when it is unset, gets the normal not-found page. Set it to your user id: sign in once, then read your id from the `user` table in Neon (`select id, email from "user";`). An id cannot be claimed by anyone else. An email only counts when your sign-in provider reports it as verified, and case does not matter. |
| `VITE_PAID_ASSETS_URL` | the Blob store base URL from "Paid animation clips" below | Optional. Read at build time. Unset means the arena opponent uses the free animation clips. |
| `VITE_SENTRY_DSN` | the DSN from step 6 | Optional. Read at build time, so changing it needs a redeploy. |

Never set `DEV_LOGIN`, `DUELWISE_DB` or `DUELWISE_AGENT_CHECK` in Vercel. Dev login is ignored in production builds anyway, but there is no reason to leave it near.

### Paid animation clips

The arena opponent's pistol, jog and crouch clips come from the purchased Quaternius Universal Animation Library 1 (Pro tier). The licence is CC0, but the paid files are kept out of the public repository and hosted separately (provenance: `docs/third-party/quaternius-paid.md`). Without them the game still works: it falls back to the free Standard clips (idle, sprint and walk stand in for the pistol stance and the jog directions).

1. Vercel dashboard, Storage, Create, Blob. Choose a **public** store in the same project's team. Note its base URL, `https://<id>.public.blob.vercel-storage.com` (not verified by an agent: the exact label may differ).
2. On the machine that holds `data/cache/assets/quaternius-paid`, run `bun scripts/paid-assets.ts`. It copies the files into `apps/web/public/paid/` (gitignored, served by the dev server) and prints one `vercel blob put ... --pathname <path> --add-random-suffix false` line per file. Run those lines (the Vercel CLI must be logged in and linked to the store; flag names not verified by an agent, check `vercel blob put --help`).
3. Set `VITE_PAID_ASSETS_URL` to the base URL for Production and redeploy (it is read at build time).
4. Check: open the arena, and in the browser network tab the `ual1-shooter.glb` request answers 200 from the Blob host. A browser console CORS error means the store must allow GET from the site origin; the game then silently uses the free clips.

### Owner observability page

`/owner` shows who played, how they did and how the AI is doing against its measured target (design v3, d-owner). It reads the `telemetry_event` table, which the server fills at match start, finish, resign and abandon with a player code, the game, level, opponent name, duration, result, device class and the training flag. No IP address, browser string, name or email is stored there, and no third-party analytics are used. Players are shown by code; the "Reveal emails" switch asks for a confirmation and writes one `owner_audit` row per email shown (`select * from owner_audit order by at desc;`). Deleting an account deletes its events. The AI win rate row raises an alert when the 95 percent interval around the measured AI score excludes the target, which is the Elo expected score of the level's measured site Elo against a new player's 1000, and only after 20 scored matches.

## 6. Sentry (optional)

1. Sentry, create a project with the React platform. Copy its DSN into `VITE_SENTRY_DSN`.
2. This wires browser error reporting only (`@sentry/react`, errors, no performance traces, no source map upload). The server bundle includes `@sentry/node` but no server DSN is read anywhere, so server errors are visible in Vercel's function logs, not in Sentry. Adding a server DSN is a code change, not a setting.
3. Sentry projects hold your users' error data. Check the project's data scrubbing defaults before launch; the privacy page promises no IP addresses or raw browser strings are stored by us, and Sentry has its own settings for that.

## 7. Deploy and smoke

1. Vercel, Deployments, Deploy (or push to the connected branch).
2. When it is Ready, run the read-only smoke test from the repository root:

   ```
   bun run smoke -- --url https://<your-site>
   ```

   It fetches every page (home, play, each game's play, stats and leaderboard page, legal pages, settings, sign in) and `/api/auth/ok`, and exits 1 if any is not a 200 HTML page. It sends GET requests only.
3. Once, to prove the upload endpoint is mounted and refuses bad data:

   ```
   bun run smoke -- --url https://<your-site> --allow-write
   ```

   This adds one POST of junk bytes to `/api/finish`, which must be answered 400. It also creates one guest row in the database, because the endpoint gives every caller a guest identity.
4. By hand, in a browser, in this order: sign in with Google, sign out, sign in with GitHub, play a Four in a Row match as the signed-in user, finish it, open the leaderboard and the stats page, open `/settings` and toggle the training switch.
5. In the Neon SQL Editor confirm the match was stored and replayed: `select id, game, status, record_valid from "match" order by finished_at desc nulls last limit 5;` should show `finished` and `true`.

## 8. If something fails

- Every page 500s: `DATABASE_URL` is missing or wrong, or the migrations were not run. Vercel, Logs shows the error.
- Sign-in button does nothing or Google says redirect_uri_mismatch: the callback URL in the provider console does not match `BETTER_AUTH_URL` exactly (scheme, host, no trailing slash).
- `/api/auth/ok` is not 200: `BETTER_AUTH_SECRET` is missing or the database is unreachable.
- Match saved as `record_valid = false`: read `invalid_reason` in the same row; the server replays every upload from the seed it issued.
- Roll back: Vercel, Deployments, pick the last good one, Promote to Production.
