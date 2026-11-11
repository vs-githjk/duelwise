#!/usr/bin/env bash
# Deploys the relay and installs the shared signing secret. Run by hand, once, after review (D9).
# The secret is generated here, held in a shell variable, and piped straight into `wrangler secret put` and
# `vercel env add`; it is never printed, never written to a file. Vercel picks the variable up on its NEXT deploy;
# this script does not deploy the site.
#
# Usage: apps/duel-relay/deploy.sh <absolute path of the main checkout that holds the linked .vercel folder>
set -euo pipefail
export WRANGLER_SEND_METRICS=false
PKG="$(cd "$(dirname "$0")" && pwd)"
WRANGLER="$PKG/../../node_modules/.bin/wrangler"
LINK_DIR="${1:?pass the absolute path of the checkout with the linked .vercel folder}"
[ -f "$LINK_DIR/.vercel/project.json" ] || { echo "no .vercel/project.json in $LINK_DIR"; exit 1; }
# 1. Refuse before touching anything if the site already has a secret: a second secret on the Worker alone would
#    leave the two sides mismatched. Rotate by hand instead (remove the Vercel variable first, on purpose).
if vercel env ls production --cwd "$LINK_DIR" 2>/dev/null | grep -q '^ *DUEL_SIGNING_SECRET '; then
  echo "DUEL_SIGNING_SECRET already exists on Vercel production. Aborting before any change; nothing was deployed or set."
  exit 1
fi
cd "$PKG"
echo "pwd: $(pwd)"
SECRET="$(openssl rand -base64 48 | tr -d '\n=+/')"
[ "${#SECRET}" -ge 40 ] || { echo "secret generation failed"; exit 1; }
# 2. Order matters: the Worker must exist; Vercel next; the Worker secret last, so any failure before it leaves the
#    Worker without a secret, where every token fails (401), never with a secret the site does not share.
"$WRANGLER" deploy
printf %s "$SECRET" | vercel env add DUEL_SIGNING_SECRET production --sensitive --cwd "$LINK_DIR"
printf %s "$SECRET" | "$WRANGLER" secret put DUEL_SIGNING_SECRET
unset SECRET
echo "done: the Worker URL is in the deploy output above (workers.dev). Set it as DUEL_RELAY_URL in the site when M5 needs it."
