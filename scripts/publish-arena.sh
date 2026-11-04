#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
common="$(bun scripts/paths.ts)"
evals="$(mktemp -d "${TMPDIR:-/tmp}/arena-evals.XXXXXXXX")"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/arena-scratch.XXXXXXXX")"
trap 'rm -rf "$evals" "$scratch"' EXIT

bots='random,rusher,holder,peeker,strafe,holdangle,human-proxy'
# Medium is Easy's network (the b4 gated snapshot) under Medium's limits: none of the 23 networks trained at Medium limits (arena-league-b5)
# beat Easy head to head (best 58 of 100 on one seat-swapped run, most below 45), so the Levels rule would refuse each of them.
# Hard is the b5 gated snapshot at 36,003,840 steps: it scores at least 0.75 on every seat against every bot and beats Medium 0.875 over 400 seat-swapped matches (the b4 Hard scored 0.685 against the peeker; the 52M and 58M snapshots beat Medium 0.60 and 0.78).
for level in easy medium hard champion; do
  case "$level" in
    easy) snapshot='arena-league-b4/gated/easy/snap-easy-0008028160.pt' ;;
    medium) snapshot='arena-league-b4/gated/easy/snap-easy-0008028160.pt' ;;
    hard) snapshot='arena-league-b5/gated/hard/snap-hard-0036003840.pt' ;;
    champion) snapshot='arena-league-b4/gated/champion/snap-champion-0012025856.pt' ;;
  esac
  scripts/py -m trainer.ppo.eval_bots --game arena --level "$level" --ckpt "$common/runs/$snapshot" --games 800 --bots "$bots" > "$evals/$level.json"
done

cat > "$evals/sources.json" <<'JSON'
{
  "easy": { "source": "runs/arena-league-b4/gated/easy/snap-easy-0008028160.pt", "step": 8028160, "obsFeatures": 90 },
  "medium": { "source": "runs/arena-league-b4/gated/easy/snap-easy-0008028160.pt", "step": 8028160, "obsFeatures": 90 },
  "hard": { "source": "runs/arena-league-b5/gated/hard/snap-hard-0036003840.pt", "step": 36003840, "obsFeatures": 90 },
  "champion": { "source": "runs/arena-league-b4/gated/champion/snap-champion-0012025856.pt", "step": 12025856, "obsFeatures": 90 }
}
JSON

bun packages/agents/src/measure/arena.ts publish --evals "$evals" --scratch "$scratch"

# Keep the eval output next to the registry: registry-rows.test.ts checks every published row against these files.
for level in easy medium hard champion; do cp "$evals/$level.json" "$root/packages/agents/eval/arena/$level.json"; done
