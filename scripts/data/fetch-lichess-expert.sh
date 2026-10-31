#!/usr/bin/env bash
# Streams Lichess open-database months into the b2200 EXPERT policy shards (both players 2200+, no bullet, no bots), for the
# human-like Hard persona (Vesper). Nothing is saved raw: curl | head -c <cap> | zstd -dc | bun expert-stream.ts.
#
#   scripts/data/fetch-lichess-expert.sh --sample                    about 30 MB of the newest month into a scratch folder, to test the pipeline
#   scripts/data/fetch-lichess-expert.sh --max-bytes 2000000000      up to 2 GB of transfer in total, newest months first
#   scripts/data/fetch-lichess-expert.sh --months 2026-09,2026-08 --max-bytes 4000000000 --resume
#
# Flags (all optional):
#   --max-bytes N        total compressed bytes to transfer over all months (default 2e9). Measured on 2026-10-31: 30 MB of the 2026-09 file held
#                        91,623 games, 1,423 of them expert (1.6 percent), so 1,000,000 positions (about 35,000 games at 20 per game) needs roughly
#                        0.75 GB; the stream stops by itself when the target is reached. The project data budget is 20e9 and the three
#                        existing buckets already took up to 18e9, so check <out>/transfer*.jsonl before raising this.
#   --month-bytes N      cap per month (default: the whole remaining --max-bytes)
#   --months A,B         months to read, in order (default: the newest 3 in https://database.lichess.org/standard/list.txt)
#   --target N           positions to collect (default 1000000, the same size as the other buckets)
#   --min-elo N          both players at or above this (default 2200)
#   --min-base N         base time in seconds at or above this (default 180; use 300 for slower games only, at a lower yield)
#   --positions-per-game N   (default 20)
#   --out DIR            default: $CHESS_CACHE_DIR, else <common root>/data/cache/chess (the b2200/ folder goes inside)
#   --resume             continue an interrupted month from <out>/expert-progress.json (repeats the transfer of the part already read,
#                        because a Lichess .zst can only be decoded from its start); finished months (expert-<month>.done) are skipped either way
# Transfer is counted per month in <out>/transfer-expert.jsonl. A month is "done" when its stream ended inside the cap, or the cap's worth
# of bytes was read; a month cut off by --max-bytes is marked done too (its progress file says how far it got), so a rerun moves on.
# Data licence: CC0, see data/README.md.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="$(cd "$HERE/../.." && pwd)"
COMMON_GIT="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir)"
COMMON_ROOT="$(cd "$COMMON_GIT/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
STREAM="$WORKTREE/packages/core/src/games/chess/expert-stream.ts"

MAX_BYTES=2000000000
MONTH_BYTES=""
MONTHS=""
TARGET=1000000
MIN_ELO=2200
MIN_BASE=180
PER_GAME=20
OUT="${CHESS_CACHE_DIR:-$COMMON_ROOT/data/cache/chess}"
RESUME=0
SAMPLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-bytes) MAX_BYTES="$2"; shift 2 ;;
    --month-bytes) MONTH_BYTES="$2"; shift 2 ;;
    --months) MONTHS="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --min-elo) MIN_ELO="$2"; shift 2 ;;
    --min-base) MIN_BASE="$2"; shift 2 ;;
    --positions-per-game) PER_GAME="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --sample) SAMPLE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$OUT" in /*) ;; *) echo "--out must be an absolute path" >&2; exit 2 ;; esac
if [ "$SAMPLE" = 1 ]; then
  MAX_BYTES=30000000
  OUT="${OUT%/}-expert-sample"
  rm -rf "$OUT"
fi
case "$MAX_BYTES" in ''|*[!0-9]*) echo "--max-bytes must be a number" >&2; exit 2 ;; esac
mkdir -p "$OUT"

if [ -z "$MONTHS" ]; then
  MONTHS="$(curl -sfL https://database.lichess.org/standard/list.txt | sed -E 's/.*rated_([0-9]{4}-[0-9]{2})\.pgn\.zst.*/\1/' | head -3 | paste -sd, -)"
  [ "$SAMPLE" = 1 ] && MONTHS="${MONTHS%%,*}"
fi
[ -n "$MONTHS" ] || { echo "could not determine the months to read" >&2; exit 1; }

used_bytes() { # sum of bytes already recorded in transfer-expert.jsonl
  [ -f "$OUT/transfer-expert.jsonl" ] || { echo 0; return; }
  sed -n 's/.*"bytes":\([0-9]*\).*/\1/p' "$OUT/transfer-expert.jsonl" | paste -sd+ - | sed 's/^$/0/' | bc
}

for MONTH in ${MONTHS//,/ }; do
  case "$MONTH" in [0-9][0-9][0-9][0-9]-[0-9][0-9]) ;; *) echo "bad month '$MONTH'" >&2; exit 2 ;; esac
  if [ -f "$OUT/expert-$MONTH.done" ]; then echo "[expert] $MONTH already done"; continue; fi
  USED="$(used_bytes)"
  LEFT=$((MAX_BYTES - USED))
  if [ "$LEFT" -le 1000000 ]; then echo "[expert] byte budget used ($USED of $MAX_BYTES); stopping before $MONTH"; break; fi
  CAP="${MONTH_BYTES:-$LEFT}"
  [ "$CAP" -gt "$LEFT" ] && CAP="$LEFT"
  URL="https://database.lichess.org/standard/lichess_db_standard_rated_${MONTH}.pgn.zst"
  echo "[expert] $MONTH $URL cap $CAP bytes (used $USED of $MAX_BYTES)"
  RES=(); [ "$RESUME" = 1 ] && RES=(--resume)
  curl -sfL "$URL" | head -c "$CAP" | tee >(wc -c > "$OUT/expert-$MONTH.bytes") | zstd -dc -q 2>/dev/null \
    | "$BUN" "$STREAM" --out "$OUT" --month "$MONTH" --target "$TARGET" --min-elo "$MIN_ELO" --min-base "$MIN_BASE" --positions-per-game "$PER_GAME" ${RES[@]+"${RES[@]}"}
  curl_rc=${PIPESTATUS[0]} rc=${PIPESTATUS[4]}
  sleep 1
  BYTES="$(cat "$OUT/expert-$MONTH.bytes" 2>/dev/null || echo 0)"
  printf '{"month":"%s","bytes":%s}\n' "$MONTH" "${BYTES:-0}" >> "$OUT/transfer-expert.jsonl"
  # curl exits 23 or 141 when head hit the byte cap or the reader stopped early; anything else is a real failure.
  # Reading exactly the cap's worth of bytes means WE cut the stream (curl then reports 23, 56 or 141); anything short of the cap with an error is a real failure.
  case "$curl_rc" in 0|23|141) ;; *) [ "${BYTES:-0}" -ge "$CAP" ] || { echo "[expert] download failed (curl exit $curl_rc) after ${BYTES:-0} of $CAP bytes; not marking $MONTH done" >&2; exit 1; } ;; esac
  [ "$rc" = 0 ] || { echo "[expert] reader failed (exit $rc)" >&2; exit 1; }
  [ -f "$OUT/expert-stats-$MONTH.json" ] || { echo "[expert] reader wrote no stats for $MONTH" >&2; exit 1; }
  cp "$OUT/expert-stats-$MONTH.json" "$OUT/expert-$MONTH.done"
  POS="$(sed -n 's/.*"positions": *\([0-9]*\).*/\1/p' "$OUT/expert-stats-$MONTH.json" | head -1)"
  echo "[expert] $MONTH finished: ${BYTES:-0} bytes read, $POS positions in total"
  [ "${POS:-0}" -ge "$TARGET" ] && { echo "[expert] target reached"; break; }
done
echo "[expert] done; shards in $OUT/b2200"
