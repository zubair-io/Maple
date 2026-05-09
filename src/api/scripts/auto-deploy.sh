#!/usr/bin/env bash
# auto-deploy.sh — Pull-based deploy trigger for Maple Self Hosted.
#
# Invoked by maple-deploy.timer (see ../maple-deploy.timer). On each tick,
# fetches origin/main and, if there are new commits, runs the restart
# script — which does the actual `git pull` + `docker build` + `docker run`.
#
# Defaults assume:
#   - repo at  /root/Maple
#   - restart at /opt/maple/restart.sh
# Override via MAPLE_REPO / MAPLE_RESTART in the unit's Environment= if
# yours differ.

set -euo pipefail

REPO="${MAPLE_REPO:-/root/Maple}"
RESTART="${MAPLE_RESTART:-/opt/maple/restart.sh}"

# Single-flight guard. The build can take longer than the timer interval;
# without this, the second tick would race the first on `docker stop maple`.
exec 9>/run/maple-deploy.lock
flock -n 9 || { echo "deploy already running, skipping"; exit 0; }

cd "$REPO"

git fetch --quiet origin main

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)

if [[ "$local_sha" == "$remote_sha" ]]; then
  exit 0
fi

echo "deploy: ${local_sha:0:12} -> ${remote_sha:0:12}"
exec "$RESTART"
