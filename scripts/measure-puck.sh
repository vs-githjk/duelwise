#!/usr/bin/env bash
# Air hockey measurement (P11). Usage: scripts/measure-puck.sh <pip|vesper|sable> [games per seat, default 400]
# Needs absolute snapshot paths in the environment:  VESPER_SNAP=<runs/.../snap-hard-*.pt>   SABLE_SNAP=<runs/.../snap-A-*.pt>
# Exports with the project's official exporter in the locked export venv (never training/.venv), checks ORT against torch on each model,
# then plays the gate and the ladder niced, two processes at a time, and appends every row to the results table in $PUCK_MD (default <out>/results.md).
# The registry is written by the publish step (scripts/publish-puck.sh), never by hand.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
common="$(bun "$root/scripts/paths.ts")"
out="${PUCK_OUT:-$common/runs/puck-measure}"
games="${2:-400}"
py="$HOME/.local/share/duelwise-export-venv/bin/python"
run="nice -n 10 bun $root/packages/agents/src/measure/puck-run.ts"
lock="${PUCK_LOCK:-}"
tag="${PUCK_TAG:+@$PUCK_TAG}"
mkdir -p "$out"
md="${PUCK_MD:-$out/results.md}"

export_model() { # <snapshot> <onnx>
  PYTHONPATH="$root/training" nice -n 10 "$py" -m trainer.ppo.export --ckpt "$1" --game puck --out "$2" > "$2.json" || { echo "export failed for $1"; exit 1; }
  $run parity --onnx "$2" --ckpt "$1" | tee "$2.parity.json" | tail -1; [ "${PIPESTATUS[0]}" = 0 ] || { echo "ORT parity failed for $2"; exit 1; }
}
step() { # run one measurement under the lane lock when given
  if [ -n "$lock" ]; then $lock "$@"; else "$@"; fi
}

case "${1:-}" in
  pip)
    step $run gate --level easy --model pip --games "$games" --procs 2 --md "$md" --out "$out/easy.json"
    ;;
  vesper)
    : "${VESPER_SNAP:?set VESPER_SNAP to the gated Vesper snapshot}"
    export_model "$VESPER_SNAP" "$out/hard.onnx"
    bun "$root/packages/agents/src/measure/puck-run.ts" source --out "$out/sources.json" --snap "$VESPER_SNAP" --onnx "$out/hard.onnx" --levels medium,hard --artifact apps/web/public/agents/puck/v1/hard.onnx || exit 1
    for lag in 1 2; do
      suffix=""; [ "$lag" = 2 ] && suffix=".lag2"
      step $run gate --level hard --model "$out/hard.onnx" --lag "$lag" --games "$games" --procs 2 --md "$md" --label "vesper$tag" --out "$out/hard$suffix.json"
      step $run gate --level medium --model "$out/hard.onnx" --lag "$lag" --games "$games" --procs 2 --md "$md" --label "marlow$tag" --out "$out/medium$suffix.json"
    done
    # Claim C2's control: the same network with the score hidden from it, against the same bots (the game's own effect on the shot rate).
    for level in medium hard; do
      step $run gate --level "$level" --model "$out/hard.onnx" --mask-score --games 200 --procs 2 --md "$md" --label "twin-$level$tag" --out "$out/$level.twin.json"
    done
    step $run pair --lower-level easy --lower-model pip --upper-level medium --upper-model "$out/hard.onnx" --games "$games" --procs 2 --md "$md" --out "$out/pair-medium.json"
    step $run pair --lower-level medium --lower-model "$out/hard.onnx" --upper-level hard --upper-model "$out/hard.onnx" --games "$games" --procs 2 --md "$md" --out "$out/pair-hard.json"
    ;;
  sable)
    : "${SABLE_SNAP:?set SABLE_SNAP to the Sable snapshot}"
    export_model "$SABLE_SNAP" "$out/champion.onnx"
    bun "$root/packages/agents/src/measure/puck-run.ts" source --out "$out/sources.json" --snap "$SABLE_SNAP" --onnx "$out/champion.onnx" --levels champion --artifact apps/web/public/agents/puck/v1/champion.onnx || exit 1
    [ -f "$out/hard.onnx" ] || { echo "measure vesper first (the Sable ladder needs hard.onnx)"; exit 1; }
    step $run pair --lower-level hard --lower-model "$out/hard.onnx" --upper-level champion --upper-model "$out/champion.onnx" --games "$games" --procs 2 --md "$md" --out "$out/pair-champion.json"
    # A: the plan's strict gate (bots see the live game). B: the same bots under Sable's own 150 ms limits. Vidyut picks the bar.
    step $run gate --level champion --model "$out/champion.onnx" --mask-score --bots human --games 200 --procs 2 --md "$md" --label "twin-champion$tag" --out "$out/champion.B.twin.json"
    for outcome in A B; do
      bots=live; [ "$outcome" = B ] && bots=human
      for lag in 1 2; do
        suffix=""; [ "$lag" = 2 ] && suffix=".lag2"
        step $run gate --level champion --model "$out/champion.onnx" --bots "$bots" --lag "$lag" --games "$games" --procs 2 --md "$md" --label "sable-$outcome$tag" --out "$out/champion.$outcome$suffix.json"
      done
    done
    ;;
  *)
    echo "usage: scripts/measure-puck.sh pip|vesper|sable [games per seat]" >&2
    exit 2
    ;;
esac
