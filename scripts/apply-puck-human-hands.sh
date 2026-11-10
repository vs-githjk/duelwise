#!/usr/bin/env bash
# Applies the human-hands re-measure (Nov 10): the registry, the eval rows and any staged model, from packages/agents/eval/puck/human-hands.
# STAGED ONLY: nothing runs this until Vidyut chooses the human-hands bar. Prints its own undo command at the end, and before it changes anything.
# Then run the puck tests and registry-rows.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
h="$root/packages/agents/eval/puck/human-hands"
[ -f "$h/puck.json" ] || { echo "no human-hands registry on this branch"; exit 1; }
files=("packages/agents/registry/puck.json")
for f in easy medium hard champion; do [ -f "$h/$f.json" ] && files+=("packages/agents/eval/puck/$f.json"); done
added=()
if [ -d "$h/staged" ]; then
  while IFS= read -r f; do rel="${f#./}"; [ -e "$root/$rel" ] || added+=("$rel"); done < <(cd "$h/staged" && find . -type f -name '*.onnx')
fi
undo="git -C $root checkout -- ${files[*]}"
[ "${#added[@]}" -gt 0 ] && undo="$undo && rm -f $(printf "$root/%s " "${added[@]}")"
echo "undo: $undo"
[ "${1:-}" = "--dry-run" ] && { echo "dry run: nothing changed"; exit 0; }
cp "$h/puck.json" "$root/packages/agents/registry/puck.json"
for f in easy medium hard champion; do [ -f "$h/$f.json" ] && cp "$h/$f.json" "$root/packages/agents/eval/puck/$f.json"; done
if [ -d "$h/staged" ]; then (cd "$h/staged" && find . -type f -name '*.onnx' | while read -r f; do mkdir -p "$root/$(dirname "$f")"; cp "$f" "$root/$f"; done); fi
echo "applied the human-hands registry"
echo "undo: $undo"
