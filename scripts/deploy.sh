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
remote_sha="$(git rev-parse "origin/$BRANCH")"

# What we last FULLY deployed — written only after install + build + restart succeed (see the
# end). HEAD is NOT that record: a pull whose install failed, or a bare `git pull` outside this
# script, advances HEAD without deploying, and "node_modules exists" says nothing about whether
# the deps match the current lockfile. Trusting either left a stale node_modules/ui-dist looking
# "already up to date" forever. The marker only moves on a successful deploy, so a broken one
# retries next run instead of being skipped.
STATE="$PWD/.git/philomatic-deployed-sha"     # inside .git — per-clone, never tracked
deployed_sha="$(cat "$STATE" 2>/dev/null || echo none)"

if [ "$deployed_sha" = "$remote_sha" ] && [ "$(git rev-parse HEAD)" = "$remote_sha" ]; then
  echo "deploy: already deployed ${remote_sha:0:9} — nothing to do"
  exit 0
fi

echo "deploy: deploying ${remote_sha:0:9} (last deployed: ${deployed_sha:0:9}, branch $BRANCH)"
git pull --ff-only origin "$BRANCH"
# `set -e` aborts here on failure, BEFORE the marker is written below — so a failed install or
# build leaves the marker behind and the next run retries, rather than recording a broken deploy.
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
# Record success LAST — reached only when the pull, install, and build all succeeded.
git rev-parse HEAD > "$STATE"
echo "deploy: done — services restarted at $(git rev-parse --short HEAD)"
