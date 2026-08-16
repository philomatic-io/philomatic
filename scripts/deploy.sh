#!/usr/bin/env bash
#
# Server-side redeploy for a self-hosted Philomatic instance. Pulls the latest deploy branch,
# reinstalls deps against the committed lockfile, rebuilds the UI, and restarts the
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
# Space-separated; a unit that isn't installed on this box is skipped with a note.
SERVICES="${PHILOMATIC_SERVICE:-philomatic-registry philomatic-instance}"

git fetch --quiet origin "$BRANCH"
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"
# BOOTSTRAP GUARD (bug found 2026-07-29): a fresh clone is already at origin/$BRANCH, so the
# SHA check alone skipped the very first install+build and the services had nothing to run.
needs_build=0
[ -d node_modules ] || needs_build=1
[ -f ui/dist/index.html ] || needs_build=1
if [ "$local_sha" = "$remote_sha" ] && [ "$needs_build" -eq 0 ]; then
  echo "deploy: already at ${local_sha:0:9} — nothing to do"
  exit 0
fi

echo "deploy: ${local_sha:0:9} -> ${remote_sha:0:9} (branch $BRANCH, bootstrap=$needs_build)"
git pull --ff-only origin "$BRANCH"
pnpm install --frozen-lockfile
pnpm ui:build
# Restart needs root. When the deploy already runs as root (no sudo on this box), call systemctl
# directly; otherwise fall back to sudo. (sudoers needs one line per service — see the header.)
for SERVICE in $SERVICES; do
  if [ "$(id -u)" -eq 0 ]; then
    systemctl restart "$SERVICE" || echo "deploy: $SERVICE not installed here — skipped"
  else
    sudo systemctl restart "$SERVICE" || echo "deploy: could not restart $SERVICE (unit not installed, or sudoers missing its line?)"
  fi
done
echo "deploy: done — services restarted at $(git rev-parse --short HEAD)"
