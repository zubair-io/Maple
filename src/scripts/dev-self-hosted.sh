#!/usr/bin/env bash
# dev-self-hosted.sh — start both dev servers for Maple Self Hosted.
#
#   1. Bun API    (port 3000, MAPLE_DEV=1)    — watches src/api/src/
#   2. Angular    (ng serve, port 4201)       — HMR
#
# There is no database to start: the API creates its SQLite library file
# (src/api/data/maple.sqlite by default) the first time it boots.
#
# The API runs in MAPLE_DEV mode so it proxies non-/api requests to the
# Angular dev server. Open http://localhost:3000 — the API serves the SPA
# and the bundle live-reloads via the proxy.
#
# Ctrl-C stops both.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

API_PID=""
WEB_PID=""

cleanup() {
  echo
  echo "[dev] stopping…"
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# 1. Bun API (background)
echo "[dev] starting Bun API on :3000 (MAPLE_DEV=1 → proxy to :4201)…"
(
  cd "$REPO_ROOT/src/api"
  PORT=3000 MAPLE_DEV=1 MAPLE_DEV_ORIGIN=http://localhost:4201 \
    bun --watch src/index.ts
) &
API_PID=$!

# 2. Angular dev server (background)
echo "[dev] starting Angular dev server on :4201…"
(
  cd "$REPO_ROOT/src/web"
  npm run start:self-hosted
) &
WEB_PID=$!

cat <<EOF

[dev] all servers up:
       API     http://localhost:3000   (PID $API_PID)
       UI dev  http://localhost:4201   (PID $WEB_PID)

       Open http://localhost:3000 — the API serves the bundle and proxies
       non-/api routes to ng serve so HMR works through one URL.

       Ctrl-C to stop.

EOF

wait
