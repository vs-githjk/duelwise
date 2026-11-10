#!/usr/bin/env bash
# Applies outcome B (Champion's gate bots under Sable's own 150 ms limits): the registry, the eval rows and the staged models.
# Run only when Vidyut has chosen that bar. Nothing else changes; then run the puck tests and registry-rows.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
b="$root/packages/agents/eval/puck/outcome-B"
[ -f "$b/puck.json" ] || { echo "no outcome B on this branch"; exit 1; }
cp "$b/puck.json" "$root/packages/agents/registry/puck.json"
for f in "$b"/*.json; do
  name="$(basename "$f")"
  case "$name" in puck.json) ;; champion.B.json) cp "$f" "$root/packages/agents/eval/puck/champion.json" ;; *) cp "$f" "$root/packages/agents/eval/puck/$name" ;; esac
done
staged=()
if [ -d "$b/staged" ]; then
  while IFS= read -r f; do staged+=("${f#./}"); done < <(cd "$b/staged" && find . -type f -name '*.onnx')
  for f in ${staged[@]+"${staged[@]}"}; do mkdir -p "$root/$(dirname "$f")"; cp "$b/staged/$f" "$root/$f"; done
fi
echo "applied outcome B"
# Undo: restore the tracked files, then remove any applied model that git does not track (outcome A ships none of them).
echo "undo: git -C '$root' checkout -- packages/agents/registry/puck.json packages/agents/eval/puck && git -C '$root' clean -f -- ${staged[*]:-}"
