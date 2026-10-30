# Add a game

This guide walks you from nothing to a game that plays in the browser, has opponents at four levels, and shows only strength numbers it has earned. It uses **Cairn**, a small example game that is already in the repo, as the template. Read Cairn first (it is about 100 lines of rules), then copy it.

Everything below was checked against the code at the commit this guide ships in. File paths are from the repo root.

## What a game is

A game is five things:

1. **Rules** in `packages/core`: a pure, seeded, headless simulation behind the shared `GameCore` interface. The same code runs in the browser, on the server (which replays every finished match to check it) and in training.
2. **An agent** in `packages/agents`: something that looks at what a player would see and returns a move. Four levels: Easy, Medium, Hard, Champion.
3. **Measurement**: matches between your levels, played by the harness, which decide which levels are allowed to show a strength number.
4. **A registry file**, `packages/agents/registry/<game>.json`: the one place every strength number on the site is read from.
5. **A play page** in `apps/web`.

Cairn has 1, 2 and 5, a scripted version of 2, and the harness test for 3. It stops short of 4, on purpose; see "Publish levels honestly".

## The template: Cairn

Rules: a pile of 13 to 24 stones (the seed picks the size). Players alternate taking 1, 2 or 3 stones. Whoever takes the last stone wins. Perfect play is to leave a multiple of four stones, so the game is solved, which makes it easy to see that the levels really differ.

| Part | File |
|---|---|
| Rules and `GameCore` | `packages/core/src/games/template/cairn.ts` |
| Rules tests | `packages/core/src/games/template/cairn.test.ts` |
| Agent, four levels | `packages/agents/src/template/agent.ts` |
| Agent tests and the level ordering test | `packages/agents/src/template/agent.test.ts` |
| Play page | `apps/web/src/dev-views/cairn.tsx` |
| Match logic the page uses | `apps/web/src/dev-views/cairn-match.ts` and `cairn-match.test.ts` |
| Browser test | `apps/web/e2e/template.spec.ts` |

Play it: `bun run dev`, then open `/dev/cairn` on the dev server. It is not in the game list, has no `/play/...` route, and in a production build the `/dev` route shows not-found, so players never see it. That is how a half-finished game stays hidden: put its page under `apps/web/src/dev-views/` until it is ready.

Cairn is deliberately **not** a product game. It has no entry in `PRODUCT.games` (`packages/core/src/product.ts`), is not in the `getCore()` registry, and is not in the agent dispatch table. A test in `cairn.test.ts` pins this. Real games are, as step 6 explains.

## The interface

Your rules implement `GameCore<State, Action, Observation>` from `packages/core/src/types.ts`:

| Member | What it must do |
|---|---|
| `id`, `version` | The game id, and a string you change whenever the rules change (records name the version they were played on). |
| `init(seed)` | Build the start state from the seed. All randomness comes from `makeRng(seed)` in `packages/core/src/rng.ts`. Never `Math.random`, `Date` or `performance.now`. |
| `toAct(state)` | The seats that must act now. One seat for turn games; `[0, 1]` every frame for realtime games; `[]` when over. |
| `legal(state, seat)` | Legal actions for that seat (`[]` when it is not their turn). Realtime games return `[]`. |
| `step(state, [a0, a1])` | The next state. Pure: do not mutate the input. Throw on an illegal or missing action. |
| `terminal`, `result` | `result` returns `{ winner, score, reason }` once over, else `null`. A draw is `winner: null`. |
| `observe(state, seat)` | What that seat may see. Hide hidden information here (cards, a secret word). Agents get only this. |
| `hash(state)` | 16 hex characters, from `hashState` in `packages/core/src/hash.ts`. Equal states must hash equal. |
| `encodeAction`, `decodeAction` | Map an action to and from a small integer. This is what a match record stores. |

For a learned agent you also write a `FeatureEncoder` (see `packages/core/src/games/four/encode.ts`) that turns an observation into the numbers a network reads. A scripted agent does not need one.

Rules for rules: deterministic, no hidden global state, and fast. Add tests for every way to win, every illegal action, and that the same seed and actions give the same hash. `cairn.test.ts` shows each.

## Step by step

### 1. Rules

Copy `packages/core/src/games/template/` to `packages/core/src/games/<id>/` and rename. Keep the shape: `<id>.ts` (or `core.ts`, `rules.ts`), `index.ts` exporting `core`, and a test file. Write the failing tests first, then the rules.

Look at `packages/core/src/games/four/` for a larger turn game with an encoder and a solver, and `packages/core/src/games/fighter/` for a realtime one.

### 2. An agent

Copy `packages/agents/src/template/agent.ts` to `packages/agents/src/<id>/agent.ts`. The contract (`packages/agents/src/agent-types.ts`):

```ts
export async function createGameAgent(level: Level, opts?: AgentOpts): Promise<PreviewAgent>
// PreviewAgent: { preview: boolean; act(obs, state?): Promise<number[]>; reset(seed): void; dispose(): void }
```

- `act` returns the **encoded** action (turn games: one integer). It should read the observation only, so it plays from what a player sees. The harness also passes the full state, which a stub may use to ask for legal moves.
- `reset(seed)` seeds the agent's own random numbers. Mix in the seat (`opts.seat`) so two agents of one level do not make identical choices.
- `preview: true` means "stand-in, not the real agent". A preview agent can play but its levels never show a strength number. Set `false` only when the agent is final.
- Levels are the four ids in `packages/core/src/product.ts` (`easy`, `medium`, `hard`, `champion`). Easy anchors the Elo scale, so every game has an Easy. Cairn's levels differ only in how often they play the perfect move. That is the whole trick for a scripted agent: one dial, and the measurement proves the dial works.

Learned agents run a neural network in the browser (ONNX Runtime Web in a Web Worker, see `packages/agents/src/four/agent.ts` and `packages/agents/src/runtime/`) and add search on top. Word Duel (`packages/agents/src/word/agent.ts`) is a good middle example: a solver with a level-dependent chance to overlook a clue.

### 3. Tests

Targeted runs only (the whole-repo `bun test` loads native modules that clash when everything runs in one process):

```
bun test packages/core/src/games/<id>
bun test packages/agents/src/<id>
bun run --cwd apps/web typecheck
```

The level ordering test in `packages/agents/src/template/agent.test.ts` is the one to copy for any game. It plays each level against the one below through the real harness (`runMatches` in `packages/agents/src/measure/harness.ts`) and requires the 95% Wilson lower bound of the score to be above 50% over 400 games. The harness alternates seats every game (A's seat is the game index modulo 2), so a level cannot win by luck of the seat.

### 4. The play page

Start from `apps/web/src/dev-views/cairn.tsx`. Keep the match logic in a plain `.ts` file (`cairn-match.ts`) so a unit test can drive a whole match without a browser. The page creates the agent, resets it with the match seed, and asks it for a move on the agent's turn.

A finished game page also uses the shared pieces: `GameShell`, `LevelPicker`, `ResultPanel`, `PlayHud`, `LeavingNotice` from `apps/web/src/components/`. `apps/web/src/games/four/index.tsx` and `useFourMatch.ts` show the full wiring: a match record is built from the seed and the human's inputs, uploaded when the match ends, and the server replays it before it counts.

### 5. Browser test

Copy `apps/web/e2e/template.spec.ts`. Run it from `apps/web` with `bunx playwright test e2e/template.spec.ts --workers=1`. Playwright starts the dev server with an in-memory database, so nothing touches your local data. UI changes need a screenshot at phone width and desktop width, in light and dark.

### 6. Make it a product game

Only when steps 1 to 5 are solid. This is the step that adds the game to the list players see, so it needs the maintainer's say before it merges.

1. Add the id to `GameId` and an entry to `PRODUCT.games` in `packages/core/src/product.ts` (display name, URL slug, `kind`: `turn`, `rounds` or `realtime`, and `devices`). Pick an original name; no trademarked game names.
2. `packages/core/src/games/index.ts`: import your `core` and add it to `CORES` and `OWNER`.
3. `packages/agents/src/agent-dispatch.ts`: add your agent to `FACTORIES`.
4. `packages/agents/src/registry.ts`: add the id to the `game` enum in `RegistrySchema`.
5. Move the page to `apps/web/src/games/<id>/index.tsx`. A game is playable when that file exists; `apps/web/src/games/registry.ts` finds it by folder name, so no route edit is needed.
6. Typecheck. TypeScript now points at every `Record<GameId, ...>` that needs your game. The files that mention game ids (found with a grep for `holdem` at this commit) include: `apps/web/src/components/GameCard.tsx`, `GameArt.tsx`, `ResultPanel.tsx`, `how-to-play-data.ts`, `apps/web/src/personas/personas.json` (each opponent's style line for your game), `apps/web/src/lib/honest-copy.ts`, `apps/web/src/lib/strength-gates.ts`, `apps/web/src/server/agent-check.ts`, `agent-models.ts`, `abandon.ts`, `apps/web/src/report/build.ts` and `training/trainer/registry.py`. Open the ones TypeScript flags and copy what the smallest existing sibling (Word Duel or Four in a Row) does.
7. Add the game to the `guidesSeen` list in `apps/web/playwright.config.ts` so specs start past the first-visit guide.

## How agents, measurement and the registry fit together

```
GameCore (rules)  ->  agent (one per level)  ->  harness plays levels against each other
                                                     |
                                              ladder: Wilson bounds, Elo
                                                     |
                                      publishLadder writes registry/<game>.json
                                                     |
                      web app reads the file, and shows a strength number only if its gate verifies
```

- **Harness** (`packages/agents/src/measure/harness.ts`): `playGame` runs one match with an agent per seat; `runMatches` plays a list of seeds, optionally across child processes, and the numbers do not depend on the process count. It can take a core and agents by module path, which is how Cairn is measured without being in the dispatch table.
- **Ladder** (`packages/agents/src/measure/ladder.ts`): `runLadder` plays each level against the next one down (Easy, then Medium over Easy, Hard over Medium, Champion over Hard). A pair is played in blocks up to a game budget (`pairBudget` in `packages/agents/src/runtime/levels.ts`: 400 games with early looks at 100 and 200, or 200 games with looks at 50 and 100 for chess; an early look stops only on a stricter 99% lower bound above 50%). It reports each pair's score with a 95% Wilson interval and converts the chain to **site Elo**, with Easy fixed at 1000. Site Elo is relative to our own levels; it is not a chess rating or any outside scale.
- **Publishing** (`publishLadder`): returns a new registry in which a level is published only if it beat the level below with a lower bound above 50%, **and** every level beneath it did too. The first level that fails, and everything above it, goes to `unpublished` with the plain reason ("in training: Hard does not beat Medium: score 0.5200 over 400 games, ..."). The failure text quotes the real numbers, including a per-seat failure when a level wins overall but loses from one seat.
- **Registry** (`packages/agents/registry/<game>.json`, schema in `packages/agents/src/registry.ts`): the game's versions, which version serves each level and its config, a `measured` block per published level (metric, value, 95% interval, number of games, opponents, site Elo, date, harness, commit), the `unpublished` reasons, and `learnsFromHumans`. `validateRegistry` checks it: a published level must have a measured block, and an interval must contain its value. **Never hand-edit these files.** A hand-edited number is a number nobody measured. A measure script writes them.

## Publish levels honestly

The rule: **a level shows a strength number only if it measurably beats the level below it, from both seats, over enough games.** Otherwise it still plays, labelled "Practice", with no number.

Two checks enforce it:

1. At measurement time, `publishLadder` as above.
2. At display time, `visibleRegistry` and `verifiedStrength` in `apps/web/src/lib/strength-gates.ts` re-check the recorded gate evidence before the page shows anything. For example, chess and Hold'em need a per-seat lower bound above 0.5 on every pair, and the fighter and arena need beating a named set of scripted bots on both seats over at least 400 games each. A level whose evidence does not verify is moved to "Practice" on the page, whatever the file says.

What this means for a new game:

- `verifiedStrength` returns `false` for a game id it does not know. Until you add your game's gate there (copy `wordPass` or `fourPass`, which read the evidence your measure script records), every level of your game shows as Practice. That is the safe default. The strength gate is part of the pull request, and a reviewer will read it.
- Use a baseline for Easy. Easy has nothing below it, so it is measured against a fixed opponent (random legal play, or a simple bot) through the `baseline` option of `runLadder`. `publishLadder` refuses to publish Easy without it.
- Do not widen a gate to make a level pass. If a level does not separate from the one below, fix the agent (change the dial) or leave the level out of the published set. A spec never gets weaker to fit an agent.
- A game with a scripted agent has nothing to train. Say so in the registry and in your pull request. Be honest about where an agent's strength comes from: a solver, self-play, a scripted bot or human matches. Only the games that retrain from human matches set `learnsFromHumans: true`.

To measure a real game, copy the closest measure script: `packages/agents/src/word/measure.ts` (scripted, plays the ladder through `harnessPlayPair`, writes the registry) or `packages/agents/src/measure/four.ts` (neural net agent, with extra gates). Measuring takes minutes to hours, not seconds. Run it niced and one heavy job at a time.

## Learning agents (optional, bigger)

A game is allowed to ship with scripted agents only. If you want it to learn:

- Self-play and league training live in `training/` (Python 3.12, PyTorch). One supervisor (`training/trainer/supervisor.py`) runs resumable, niced jobs described by JSON files in `training/jobs/`. Four in a Row (`training/trainer/four/`), the realtime games (`training/trainer/ppo/`) and chess (`training/trainer/chess/`) are the examples. Export the network to ONNX with `training/trainer/export_onnx.py`; the browser runs it.
- Learning from human matches is built for Four in a Row only (`training/trainer/retrain.py`, `bun run retrain -- --game four`). It exports filtered human matches, trains a challenger, and promotes it only if it beats the current champion over at least 400 games with a score of at least 0.55 and a Wilson lower bound above 0.5. Wiring a second game to it needs a trainer adapter like `training/trainer/four/retrain_adapter.py`.

## Open a pull request

1. Branch from the main branch, one game per branch, named `game/<id>`.
2. Make the checks pass, each from the repo root unless noted:
   - `bun test packages/core/src/games/<id>`
   - `bun test packages/agents/src/<id>`
   - `bun run --cwd apps/web typecheck`
   - `bunx playwright test e2e/<id>.spec.ts --workers=1` from `apps/web`
   - `bun run guards` (banned terms, no em or en dashes, honest numbers)
3. Commit only the files you changed, with a plain message such as `add <id>: rules, agent, page, tests`. No attribution trailers.
4. Open the pull request with: what the game is and its rules in two sentences; your level table (the dial for each level and the measured scores with game counts); where the agent's strength comes from, in plain words; screenshots of the page at phone and desktop width; and anything you skipped.
5. A maintainer reviews the rules, the tests, the measurement and the strength gate before it merges. They may ask for changes; the usual round is a short fix list.

Things that will bounce a pull request: a trademarked game name, a registry file edited by hand, a gate loosened to pass, randomness that is not from the seed, a strength number without games behind it, and a game page that fakes a feature it does not have.

## Cairn does not do

- It does not upload match records or rate players. Records and the server-side replay need a real `GameId` (step 6).
- It has no strength gate in `strength-gates.ts` and no registry file. Both come with step 6 and the measurement above.
- It has no neural network, no feature encoder and no training job.
- Its page does not use the shared shell components, so it is short enough to read in one sitting.
