#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
common="$(bun scripts/paths.ts)"
evals="$(mktemp -d "${TMPDIR:-/tmp}/arena-evals.XXXXXXXX")"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/arena-scratch.XXXXXXXX")"
trap 'rm -rf "$evals" "$scratch"' EXIT

bots='random,rusher,holder,peeker,strafe,holdangle,human-proxy'
for level in easy hard champion; do
  case "$level" in
    easy) snapshot='snap-easy-0008028160.pt' ;;
    hard) snapshot='snap-hard-0012025856.pt' ;;
    champion) snapshot='snap-champion-0012025856.pt' ;;
  esac
  scripts/py -m trainer.ppo.eval_bots --game arena --level "$level" --ckpt "$common/runs/arena-league-b4/gated/$level/$snapshot" --games 800 --bots "$bots" > "$evals/$level.json"
done

cat > "$evals/sources.json" <<'JSON'
{
  "easy": { "source": "runs/arena-league-b4/gated/easy/snap-easy-0008028160.pt", "step": 8028160, "obsFeatures": 90 },
  "hard": { "source": "runs/arena-league-b4/gated/hard/snap-hard-0012025856.pt", "step": 12025856, "obsFeatures": 90 },
  "champion": { "source": "runs/arena-league-b4/gated/champion/snap-champion-0012025856.pt", "step": 12025856, "obsFeatures": 90 }
}
JSON

bun packages/agents/src/measure/arena.ts publish --evals "$evals" --scratch "$scratch" --hold 'hard=the shipped network won about 63 of 100 against the waiting test bot and 62 of 100 against the peeking one in the browser-side harness (arena-fairness.test.ts, 400 matches each), where the training gate measured 78 and 73 of 100; it stays Practice until the two agree'

# Keep the eval output next to the registry: registry-rows.test.ts checks every published row against these files.
for level in easy hard champion; do cp "$evals/$level.json" "$root/packages/agents/eval/arena/$level.json"; done
