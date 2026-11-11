#!/usr/bin/env bash
# A9: publishes Glasscut's Pip (Easy) and Marlow (Medium, the v2 network) into packages/agents/registry/puck.json, from measured results and never by hand.
# Vesper and Sable keep the human-hands rows they were published with; only their site Elo moves, because the ladder now chains through the new Marlow.
# Needs: runs/puck-a9/easy.json (Pip's gate against bots at its own hands, written by `puck-run.ts gate --level easy --model pip --bots human`) and the
# A8 measurements kept in plan/retune/a8 (Marlow's gate against bots at its own hands, the two ladder pairs, the ORT parity). Marlow's gate row set is the one
# the Nov 10 18:52 ruling names for Easy and Medium: bots at the level's own hands, the people panel and the ladder decide. The 12-frame strong-hands
# rows for Marlow stay in plan/retune/a8/gate-medium.json and are quoted in the A9 report.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
common="$(bun "$root/scripts/paths.ts")"
res="$common/runs/puck-a9"
reg="$root/packages/agents/registry/puck.json"
[ -f "$res/easy.json" ] || { echo "missing $res/easy.json (run the Pip gate first)"; exit 1; }
for f in hard.json hard.twin.json hard.d18.json hard.onnx hard.onnx.json hard.onnx.parity.json champion.json champion.twin.json champion.d18.json champion.onnx champion.onnx.json champion.onnx.parity.json pair-champion.json; do
  cp "$common/runs/puck-regate/$f" "$res/$f"
done
cp "$root/plan/retune/a8/gate-medium-human.json" "$res/medium.json"
cp "$root/plan/retune/a8/pair-medium.json" "$root/plan/retune/a8/pair-hard.json" "$res/"
cp "$root/apps/web/public/agents/puck/v2/medium.onnx" "$res/medium.onnx"
cp "$root/plan/retune/a8/marlow-parity.json" "$res/medium.onnx.parity.json"
cat > "$res/sources.json" <<JSON
{
  "medium": { "source": "runs/puck-league-b-medium/gated/medium/snap-medium-0040009728.pt", "step": 40009728, "absolute": "$res/medium.onnx", "artifact": "apps/web/public/agents/puck/v2/medium.onnx" },
  "hard": { "source": "runs/puck-league-b-hard/gated/hard/snap-hard-0112001024.pt", "step": 112001024, "absolute": "$res/hard.onnx", "artifact": "apps/web/public/agents/puck/v1/hard.onnx" },
  "champion": { "source": "runs/puck-league-a/league/A/snap-A-0278003712.pt", "step": 278003712, "absolute": "$res/champion.onnx", "artifact": "apps/web/public/agents/puck/v1/champion.onnx" }
}
JSON
cp "$reg" "$res/puck.before.json"
bun "$root/packages/agents/src/measure/puck-run.ts" publish --results "$res" --champion H --existing "$res/puck.before.json" --registry "$reg" --evals "$root/packages/agents/eval/puck"
# Vesper and Sable were not re-measured: put back their measured stamps (value, interval, date, commit) and keep only the new site Elo.
bun -e "
const fs = require('fs')
const before = JSON.parse(fs.readFileSync('$res/puck.before.json', 'utf8'))
const after = JSON.parse(fs.readFileSync('$reg', 'utf8'))
for (const level of ['hard', 'champion']) after.measured[level] = { ...before.measured[level], siteElo: after.measured[level].siteElo }
fs.writeFileSync('$reg', JSON.stringify(after, null, 2) + '\n')
"
echo "published; run the puck tests, registry-rows and the people step next"
