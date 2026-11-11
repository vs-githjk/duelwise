#!/usr/bin/env bash
# puck-2 pace: publishes Glasscut's four levels into packages/agents/registry/puck.json from the re-measure on the slower puck, never by hand.
# Usage: scripts/publish-puck-pace.sh <results dir>   (the dir holds <level>.json gates, hard/champion .d18 and .twin, pair-*.json, sources.json, the models and their .parity.json)
# Every level was measured on puck-2: the people panel and the scripted-bot gates (Easy and Medium at their own hands per the Nov 10 18:52 ruling, Hard and Champion on human hands
# at 12 frames with the 18 frame run as the slower person), the ladder and the score-hidden twins. The raw files are kept in packages/agents/eval/puck/pace.
# Run the people step after it:  bun packages/agents/src/measure/a9-apply.ts people puck
# DEPLOY / ROLLBACK (puck-2): the relay runs the puck sim for realtime Glasscut, so the relay and the site must go out together from the same tree, and a
# rollback must cover BOTH. Rolling back only the site leaves a puck-1 page against a puck-2 relay (refused: closes 1009 "Something went wrong. Reload the page"),
# and rolling back only the relay leaves a puck-2 page against a puck-1 relay (no check, silent desync). Rooms open during the switch void; old puck-1 records keep the result only.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
res="${1:?results dir (absolute)}"
reg="$root/packages/agents/registry/puck.json"
cp "$reg" "$res/puck.before.json"
bun "$root/packages/agents/src/measure/puck-run.ts" publish --results "$res" --champion H --existing "$res/puck.before.json" --registry "$reg" --evals "$root/packages/agents/eval/puck"
echo "published; run the puck tests, registry-rows and the people step next"
