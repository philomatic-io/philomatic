#!/usr/bin/env bash
#
# Server-side redeploy for a self-hosted Philomatic instance. Pulls the latest deploy branch,
# reinstalls deps against the committed lockfile, rebuilds the UI + demo, and restarts the
# registry service. Idempotent — a no-op when already up to date, so it's safe to run from a
# systemd timer, a GitHub webhook, a CI SSH step, or by hand.
#
# Prereqs on the server (one-time):
#   1. A working clone at this repo root that tracks the deploy branch (default: origin/main).
#   2. pnpm + node on PATH (or edit PATH below for a systemd unit's minimal env).
#   3. Passwordless sudo for JUST the restart — /etc/sudoers.d/philomatic:
#        <deploy-user> ALL=(root) NOPASSWD: /usr/bin/systemctl restart philomatic-registry
#      (find systemctl's path with `command -v systemctl`.)
#
# Triggering "on push to main" (pick one — see the release notes / README):
#   - systemd timer polling every ~2 min (no inbound access needed — best behind NAT), or
#   - a GitHub Actions job that SSHes in and runs this script (server must be reachable), or
#   - a webhook listener that runs this script on the push event.
set -euo pipefail

cd "$(dirname "$0")/.."                       # repo root
BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE="${PHILOMATIC_SERVICE:-philomatic-registry}"

git fetch --quiet origin "$BRANCH"
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"
if [ "$local_sha" = "$remote_sha" ]; then
  echo "deploy: already at ${local_sha:0:9} — nothing to do"
  exit 0
fi

echo "deploy: ${local_sha:0:9} -> ${remote_sha:0:9} (branch $BRANCH)"
git pull --ff-only origin "$BRANCH"
pnpm install --frozen-lockfile
pnpm ui:build
pnpm demo:build
sudo systemctl restart "$SERVICE"
echo "deploy: done — restarted $SERVICE at $(git rev-parse --short HEAD)"
