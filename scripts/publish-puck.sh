#!/usr/bin/env bash
# Writes the puck registry from measured results (never by hand). Usage: scripts/publish-puck.sh [results dir]
# Outcome A (the plan's strict Champion gate, bots see the live game) goes to packages/agents/registry/puck.json with the eval rows
# in packages/agents/eval/puck and the published models in apps/web/public/agents/puck/v1.
# Outcome B (Champion's bots under Sable's own 150 ms limits) is written beside it, ready to apply, and changes nothing live:
# packages/agents/eval/puck/outcome-B/{puck.json,champion.B.json,staged/...}; scripts/apply-puck-outcome-b.sh applies it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
common="$(bun "$root/scripts/paths.ts")"
results="${1:-$common/runs/puck-measure}"
run="bun $root/packages/agents/src/measure/puck-run.ts"
reg="$root/packages/agents/registry/puck.json"
cp "$reg" "$results/puck.before.json"

if [ -f "$results/champion.B.json" ]; then
  mkdir -p "$root/packages/agents/eval/puck/outcome-B"
  $run publish --results "$results" --champion B --existing "$results/puck.before.json" --registry "$root/packages/agents/eval/puck/outcome-B/puck.json" --evals "$root/packages/agents/eval/puck/outcome-B" --models "$root/packages/agents/eval/puck/outcome-B/staged"
fi
$run publish --results "$results" --champion A --existing "$results/puck.before.json" --registry "$reg" --evals "$root/packages/agents/eval/puck"
