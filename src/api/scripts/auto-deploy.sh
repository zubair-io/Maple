#!/usr/bin/env bash
# auto-deploy.sh — Pull-based deploy trigger for Maple Self Hosted.
#
# Started by maple-deploy-webhook.service on a push to main, and by
# maple-deploy.timer as a backstop. Fetches origin/main and, while there are
# new commits, runs the restart script — which does the actual `git pull` +
# `docker build` + `docker run`.
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
flock -n 9 || {
	echo "deploy already running, skipping"
	exit 0
}

cd "$REPO"

# Loop until caught up: a push that lands mid-build starts this unit again,
# but systemd folds that start into the run already in progress.
while true; do
	git fetch --quiet origin main

	local_sha=$(git rev-parse HEAD)
	remote_sha=$(git rev-parse origin/main)

	if [[ "$local_sha" == "$remote_sha" ]]; then
		exit 0
	fi

	echo "deploy: ${local_sha:0:12} -> ${remote_sha:0:12}"
	"$RESTART"

	if [[ "$(git rev-parse HEAD)" == "$local_sha" ]]; then
		echo "deploy: restart left HEAD at ${local_sha:0:12}; not retrying" >&2
		exit 1
	fi
done
