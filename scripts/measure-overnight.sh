#!/usr/bin/env bash
set -uo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
if [ "${MEASURE_CAFFEINATED:-}" != 1 ]; then
  export MEASURE_CAFFEINATED=1
  exec caffeinate -i "$0" "$@"
fi
dry_run=false
log=plan/measure-overnight.log
for arg in "$@"; do
  if [ "$arg" = --dry-run ]; then
    dry_run=true
  else
    log=$arg
  fi
done
cd "$root" || exit 1
case "$log" in /*) ;; *) log="$root/$log" ;; esac
data="${log}.fighter-data"
runs_root=$root
if [ ! -d "$runs_root/runs/fighter-league-b5" ]; then
  runs_root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd) || exit 1
fi
hard="$runs_root/runs/fighter-league-b5/gated/hard/snap-hard-0030015488.pt"
champion="$runs_root/runs/fighter-league-b5/gated/champion/snap-champion-0026017792.pt"
practice_model="$root/apps/web/public/agents/fighter/preview/medium.onnx"
results=()
start_head=$(git rev-parse HEAD) || exit 1
start_status=$(git status --porcelain -- . ':!packages/agents/registry' ':!plan') || exit 1
exec 3>&1

check_code() {
  local head status
  head=$(git rev-parse HEAD) && status=$(git status --porcelain -- . ':!packages/agents/registry' ':!plan') || {
    echo 'ABORT: unable to check code state; remaining steps skipped.' >&3
    exit 1
  }
  if [ "$head" != "$start_head" ] || [ "$status" != "$start_status" ]; then
    echo 'ABORT: code changed mid-run; remaining steps skipped.' >&3
    exit 1
  fi
}

command_run() {
  if $dry_run; then
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
    local status=$?
    check_code
    return "$status"
  fi
}

fighter_eval() {
  command_run scripts/py -m trainer.ppo.eval_bots --game fighter --level "$1" --ckpt "$2" --games 800 > "$3"
}

fighter() {
  local status=0 gate_status level
  local -a failed_args=()
  if ! $dry_run; then
    data=$(mktemp -d "${data}.XXXXXXXX") || return 1
  fi
  command_run mkdir -p "$data/evals" "$data/scratch" || status=1
  if $dry_run; then
    printf 'scripts/py -m trainer.ppo.eval_bots --game fighter --level hard --ckpt %q --games 800 > %q\n' "$hard" "$data/evals/hard.json"
    printf 'scripts/py -m trainer.ppo.eval_bots --game fighter --level champion --ckpt %q --games 800 > %q\n' "$champion" "$data/evals/champion.json"
  else
    fighter_eval hard "$hard" "$data/evals/hard.json" || status=1
    fighter_eval champion "$champion" "$data/evals/champion.json" || status=1
  fi
  command_run cp "$practice_model" "$data/scratch/easy.onnx" || status=1
  command_run cp "$practice_model" "$data/scratch/medium.onnx" || status=1
  local pair_script='import { playPairPoints } from "./packages/agents/src/measure/fighter.ts"; const hard = new Uint8Array(await Bun.file("apps/web/public/agents/fighter/v1/hard.onnx").arrayBuffer()); const champion = new Uint8Array(await Bun.file("apps/web/public/agents/fighter/v1/champion.onnx").arrayBuffer()); const points = await playPairPoints({level:"hard",bytes:hard}, {level:"champion",bytes:champion}, 400); console.log(JSON.stringify({lower:"hard",upper:"champion",points,score:points/400,n:400}));'
  if $dry_run; then
    printf 'bun -e %q > %q\n' "$pair_script" "$data/evals/pair-hard-champion.json"
  else
    command_run bun -e "$pair_script" > "$data/evals/pair-hard-champion.json" || status=1
  fi
  if $dry_run; then
    printf 'printf %%s %q > %q\n' '{"hard":{"source":"runs/fighter-league-b5/gated/hard/snap-hard-0030015488.pt","step":30015488,"obsFeatures":162},"champion":{"source":"runs/fighter-league-b5/gated/champion/snap-champion-0026017792.pt","step":26017792,"obsFeatures":162}}' "$data/evals/sources.json"
    for level in hard champion; do
      command_run bun -e 'import { gateLevel, BARS } from "./packages/agents/src/measure/fighter.ts"; const rows = await Bun.file(process.argv[2]).json(); process.exit(gateLevel(process.argv[1], rows, BARS, true, 400).passed ? 0 : 2)' "$level" "$data/evals/$level.json"
    done
    command_run bun packages/agents/src/measure/fighter.ts publish --evals "$data/evals" --scratch "$data/scratch" '[--failed level=rows-file ...]'
    command_run cat "$data/evals/pair-hard-champion.json"
    return 0
  fi
  printf '{"hard":{"source":"runs/fighter-league-b5/gated/hard/snap-hard-0030015488.pt","step":30015488,"obsFeatures":162},"champion":{"source":"runs/fighter-league-b5/gated/champion/snap-champion-0026017792.pt","step":26017792,"obsFeatures":162}}\n' > "$data/evals/sources.json" || status=1
  if [ "$status" -ne 0 ]; then
    echo 'Fighter inputs or pair failed; refusing to publish incomplete measurements.' >&2
    return 1
  fi
  for level in hard champion; do
    gate_status=0
    command_run bun -e 'import { gateLevel, BARS } from "./packages/agents/src/measure/fighter.ts"; const rows = await Bun.file(process.argv[2]).json(); process.exit(gateLevel(process.argv[1], rows, BARS, true, 400).passed ? 0 : 2)' "$level" "$data/evals/$level.json" || gate_status=$?
    if [ "$gate_status" -eq 2 ]; then
      failed_args+=(--failed "$level=$data/evals/$level.json")
    elif [ "$gate_status" -ne 0 ]; then
      echo "$level gate check failed with exit $gate_status; refusing to publish." >&2
      return 1
    fi
  done
  command_run bun packages/agents/src/measure/fighter.ts publish --evals "$data/evals" --scratch "$data/scratch" "${failed_args[@]}" || status=1
  return "$status"
}

run_step() {
  local name=$1 status
  shift
  if $dry_run; then
    "$@"
    return
  fi
  printf '%s START %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$name" >> "$log"
  "$@" > "${log}.${name}.out" 2>&1
  status=$?
  check_code
  printf '%s END %s exit=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$name" "$status" >> "$log"
  if [ "$status" -eq 0 ]; then results+=("$name OK"); else results+=("$name FAIL ($status)"); fi
}

if ! $dry_run; then
  mkdir -p "$(dirname "$log")" || exit 1
fi
run_step fighter fighter
run_step arena command_run scripts/publish-arena.sh
run_step holdem command_run bun packages/agents/src/measure/holdem.ts publish
run_step chess command_run bun packages/agents/src/measure/chess.ts publish
if $dry_run; then
  command_run git status --short packages/agents/registry
else
  printf '\nSummary:\n'
  printf '%s\n' "${results[@]}"
  printf '\nHard vs Champion:\n'
  if [ -f "$data/evals/pair-hard-champion.json" ]; then cat "$data/evals/pair-hard-champion.json"; else echo 'Not available.'; fi
  printf '\nRegistry status:\n'
  git status --short packages/agents/registry
fi
