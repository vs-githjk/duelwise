#!/usr/bin/env bash
# Streams Lichess open-database files into chess training shards. Nothing is saved raw: each file is
# fetched with curl, cut off at a byte cap, decompressed with zstd and consumed by a Bun reader that
# stops (and so stops the download) as soon as its targets are met.
#
#   scripts/data/fetch-lichess.sh all            # policy shards for three rating buckets, then value shards
#   scripts/data/fetch-lichess.sh pgn|eval       # one stage
#   scripts/data/fetch-lichess.sh all --sample   # about 5 minutes into data/cache/chess-sample, to measure rates
#
# Output (under <common root>/data/cache/chess, shared by every worktree): b1100/, b1500/, b1900/ (policy
# shards) and value/ (value shards), each with index.json; stats.json per stage; transfer.json (bytes
# fetched). A finished stage leaves <stage>.done and is skipped on a rerun. An interrupted stage starts
# over (its shard directory is cleared), so the supervisor's --resume flag is accepted and has no other effect.
# Environment: LICHESS_MONTH (default: newest in the standard list), PGN_CAP_BYTES (default 14e9),
# EVAL_CAP_BYTES (default 4e9; the two caps keep the total under the 20 GB budget), PGN_TARGET (positions per
# bucket, default 1000000), EVAL_TARGET (default 3000000).
# Data licence: CC0, see data/README.md.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="$(cd "$HERE/../.." && pwd)"
COMMON_GIT="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir)"
COMMON_ROOT="$(cd "$COMMON_GIT/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
CHESS="$WORKTREE/packages/core/src/games/chess"

STAGE="all"
SAMPLE=0
for arg in "$@"; do
  case "$arg" in
    all|pgn|eval) STAGE="$arg" ;;
    --sample) SAMPLE=1 ;;
    --resume) ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$SAMPLE" = 1 ]; then
  OUT="$COMMON_ROOT/data/cache/chess-sample"
  PGN_EXTRA=(--max-seconds 180); EVAL_EXTRA=(--max-seconds 60)
  PGN_TARGET="${PGN_TARGET:-1000000}"; EVAL_TARGET="${EVAL_TARGET:-3000000}"
else
  OUT="$COMMON_ROOT/data/cache/chess"
  PGN_EXTRA=(); EVAL_EXTRA=()
  PGN_TARGET="${PGN_TARGET:-1000000}"; EVAL_TARGET="${EVAL_TARGET:-3000000}"
fi
PGN_CAP_BYTES="${PGN_CAP_BYTES:-14000000000}"
EVAL_CAP_BYTES="${EVAL_CAP_BYTES:-4000000000}"
mkdir -p "$OUT"

MONTH="${LICHESS_MONTH:-}"
if [ -z "$MONTH" ]; then
  MONTH="$(curl -sfL https://database.lichess.org/standard/list.txt | head -1 | sed -E 's/.*rated_([0-9]{4}-[0-9]{2})\.pgn\.zst.*/\1/')"
fi
case "$MONTH" in [0-9][0-9][0-9][0-9]-[0-9][0-9]) ;; *) echo "could not determine the month (got '$MONTH')" >&2; exit 1 ;; esac

record_bytes() { # name file
  local n; n="$(cat "$2" 2>/dev/null || echo 0)"
  printf '{"name":"%s","bytes":%s}\n' "$1" "${n:-0}" >> "$OUT/transfer.jsonl"
}

# curl exits 23 or 141 when head hit the byte cap or the reader stopped early; anything else is a real failure.
curl_ok() { # stage curl_rc
  case "$2" in 0|23|141) return 0 ;; esac
  echo "[fetch] $1 download failed (curl exit $2); not marking the stage done" >&2
  return 1
}

# Mark a stage done only for a complete result: all targets reached, or the cap's worth of bytes consumed.
stage_complete() { # stage stats_file bytes_file cap
  local reason bytes
  reason="$(sed -n 's/.*"reason" *: *"\([^"]*\)".*/\1/p' "$2" | head -n 1)"
  [ "$reason" = "targets reached" ] && return 0
  bytes="$(cat "$3" 2>/dev/null || echo 0)"
  if [ "$reason" = "end of stream" ] && [ "${bytes:-0}" -ge "$4" ]; then return 0; fi
  echo "[fetch] $1 incomplete (reason '$reason', ${bytes:-0} of $4 bytes); not marking done" >&2
  return 1
}

stage_pgn() {
  [ -f "$OUT/pgn.done" ] && { echo "[fetch] pgn already done"; return 0; }
  local url="https://database.lichess.org/standard/lichess_db_standard_rated_${MONTH}.pgn.zst"
  echo "[fetch] pgn $url cap ${PGN_CAP_BYTES} bytes"
  rm -f "$OUT/stats.json" "$OUT/pgn.bytes"
  curl -sfL "$url" | head -c "$PGN_CAP_BYTES" | tee >(wc -c > "$OUT/pgn.bytes") | zstd -dc -q 2>/dev/null \
    | "$BUN" "$CHESS/pgn-stream.ts" --out "$OUT" --month "$MONTH" --targets "b1100=$PGN_TARGET,b1500=$PGN_TARGET,b1900=$PGN_TARGET" ${PGN_EXTRA[@]+"${PGN_EXTRA[@]}"}
  local curl_rc=${PIPESTATUS[0]} rc=${PIPESTATUS[4]}
  record_bytes "pgn-$MONTH" "$OUT/pgn.bytes"
  curl_ok pgn "$curl_rc" || return 1
  [ "$rc" = 0 ] || { echo "[fetch] pgn reader failed (exit $rc)" >&2; return 1; }
  [ -f "$OUT/stats.json" ] || { echo "[fetch] pgn reader wrote no stats.json" >&2; return 1; }
  mv "$OUT/stats.json" "$OUT/pgn.stats.json"
  [ "$SAMPLE" = 1 ] || stage_complete pgn "$OUT/pgn.stats.json" "$OUT/pgn.bytes" "$PGN_CAP_BYTES" || return 1
  [ "$SAMPLE" = 1 ] || cp "$OUT/pgn.stats.json" "$OUT/pgn.done"
}

stage_eval() {
  [ -f "$OUT/value.done" ] && { echo "[fetch] eval already done"; return 0; }
  local url="https://database.lichess.org/lichess_db_eval.jsonl.zst"
  echo "[fetch] eval $url cap ${EVAL_CAP_BYTES} bytes"
  mkdir -p "$OUT/value"
  rm -f "$OUT/value/stats.json" "$OUT/eval.bytes"
  curl -sfL "$url" | head -c "$EVAL_CAP_BYTES" | tee >(wc -c > "$OUT/eval.bytes") | zstd -dc -q 2>/dev/null \
    | "$BUN" "$CHESS/eval-stream.ts" --out "$OUT/value" --target "$EVAL_TARGET" ${EVAL_EXTRA[@]+"${EVAL_EXTRA[@]}"}
  local curl_rc=${PIPESTATUS[0]} rc=${PIPESTATUS[4]}
  record_bytes "eval" "$OUT/eval.bytes"
  curl_ok eval "$curl_rc" || return 1
  [ "$rc" = 0 ] || { echo "[fetch] eval reader failed (exit $rc)" >&2; return 1; }
  [ -f "$OUT/value/stats.json" ] || { echo "[fetch] eval reader wrote no stats.json" >&2; return 1; }
  [ "$SAMPLE" = 1 ] || stage_complete eval "$OUT/value/stats.json" "$OUT/eval.bytes" "$EVAL_CAP_BYTES" || return 1
  [ "$SAMPLE" = 1 ] || cp "$OUT/value/stats.json" "$OUT/value.done"
}

case "$STAGE" in
  pgn) stage_pgn ;;
  eval) stage_eval ;;
  all) stage_pgn && stage_eval ;;
esac
rc=$?
echo "[fetch] $STAGE finished with exit $rc"
exit $rc
