# Morning checklist

Run these from the checkout you are reviewing. Nothing here pushes, deploys or changes a database.

Start in the main checkout (a lane worktree has its own folder with the same commands):

```
cd <path to the checkout you are reviewing>
date
git status --short
git log --oneline -15
```

## 1. What happened overnight

```
cat plan/progress.md
tail -80 plan/runlog.md
bun run train -- status
```

Look for parked or `needs_context` tasks first; each states the one question it needs answered.

## 2. Is it green

```
python3 scripts/run_suite.py --label morning --compare plan/suite/base.json
```

It prints REGRESSIONS and NEW FILES NOT PASSING; both should be empty. It takes a while and can be sharded: add `--shard 1/3`, `--shard 2/3`, `--shard 3/3` in three runs.

Quick checks on their own:

```
bun run guards
bun run typecheck
bun scripts/third-party.ts --check
```

`--check` fails when THIRD_PARTY.md is out of date or a pack or copied file has no credit. Fix it with `bun scripts/third-party.ts` (rewrites THIRD_PARTY.md), then commit that file.

## 3. Does the production build work

```
bun run smoke
```

It builds `apps/web`, serves the build on a free port with a throwaway in-memory database, fetches every page, sends one junk upload (must be refused with 400), and plays a whole Four in a Row match through the real handlers on a temp database, then checks the stored row. Expect `smoke: all N checks passed`.

## 4. Look at it

```
DEV_LOGIN=1 bun run dev
```

Open http://localhost:3000 (main checkout; lane worktrees use 3100, 3200, 3300). Play one game at Easy and one at the top level you can, finish a match, open `/agents/<game>` and `/leaderboard/<game>`. A game without measured levels must say "preview".

## 5. Decisions waiting for you

- Stockfish for the chess Elo anchor (T43): `brew install stockfish`, then queue the task. Your call, not an agent's.
- Product name: still provisional (`PRODUCT.name` in `packages/core/src/product.ts`).
- Training notice basis: `legitimate-interest` with an opt-out; the `opt-in` switch exists if you change your mind.
- Anything in the runlog marked `done_with_concerns`.

## 6. Ship it (only when you say so)

1. `git fetch` and check the branch has not diverged.
2. Push your branch to your private GitHub repository yourself.
3. Follow `docs/deploy.md` from section 1. Neon migrations are yours to run.
4. After deploy: `bun run smoke -- --url https://<your-site>`, then once `bun run smoke -- --url https://<your-site> --allow-write`.
