# Contributing to Duelwise

Thanks for looking. The most useful contributions are new games and clear bug reports.

## Report a bug

Open an issue with the game, the opponent level, your device and browser, what you expected and what happened. A screenshot or a match link helps.

For a security problem, open an issue that says you found one and leave the details out. The maintainer will arrange a private way to share them.

## Add a game

You can add your own game. **[docs/add-a-game.md](docs/add-a-game.md)** walks through it with a small example called Cairn.

Before you start, open an issue with the game's rules and a proposed name, so two people do not build the same thing. Pick an original name; trademarked game names are not accepted.

A game needs:

- Rules in `packages/core`, seeded so a match can be replayed exactly
- Four opponent levels: Easy, Medium, Hard and Champion
- Tests, and a play page that works at phone and desktop width

The opponents do not need machine learning. A rule-based bot is fine if each level clearly beats the one below it. Strength numbers come only from measured games, and a level that cannot prove itself is labelled In training.

Keep the game on a `game/<id>` branch, one game per branch, and hidden under `apps/web/src/dev-views/` until it is ready. Adding it to the list players see needs the maintainer's agreement.

## Improve the code

Small fixes can go straight to a pull request. For anything larger, open an issue first. Changing how an existing opponent plays needs new measurements behind it, and registry files come from the publishing tools, never from hand edits.

## Run it locally

```
bun install
bun run dev
```

Run tests one file or spec at a time, as the README explains. The whole-repo `bun test` loads native modules that clash in one process.

## Pull requests

1. Fork the repo and branch from `main`.
2. Run the tests for what you changed, then `bun run guards` and `bun run --cwd apps/web typecheck`.
3. Commit only your own files, with a plain message.
4. Describe what changed and how you tested it. For UI changes, add phone and desktop screenshots.

The maintainer reviews every pull request and may send back a short fix list. These will bounce a pull request:

- A trademarked game name
- A registry file edited by hand
- A strength gate loosened so something passes
- Randomness that does not come from the seed
- A strength number without games behind it
- A page that fakes a feature it does not have

By contributing, you agree that your work is released under the MIT license in `LICENSE`.
