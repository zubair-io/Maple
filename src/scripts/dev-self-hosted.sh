#!/usr/bin/env bash
# dev-self-hosted.sh — start all three dev servers for Maple Self Hosted.
#
#   1. MongoDB    (Docker, port 27017)        — left running on exit
#   2. Bun API    (port 3000, MAPLE_DEV=1)    — watches src/api/src/
#   3. Angular    (ng serve, port 4201)       — HMR
#
# The API runs in MAPLE_DEV mode so it proxies non-/api requests to the
# Angular dev server. Open http://localhost:3000 — the API serves the SPA
# and the bundle live-reloads via the proxy.
#
# Ctrl-C stops the API and the dev server. Mongo stays running (slow to
# start). Stop it with: docker compose -f src/api/docker-compose.yml down

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

# 1. Mongo — try Docker first; otherwise check if it's already reachable
#    (Homebrew install, or a system-managed mongod). Don't fail hard if neither
#    is available — the API will report DB-unavailable on each request and the
#    user can decide what to do.
if command -v docker > /dev/null 2>&1; then
  echo "[dev] starting MongoDB via Docker…"
  docker compose -f "$REPO_ROOT/src/api/docker-compose.yml" up -d mongo > /dev/null
  sleep 2
elif (echo > /dev/tcp/localhost/27017) 2>/dev/null; then
  echo "[dev] MongoDB already reachable on :27017 (skipping Docker)."
else
  echo "[dev] WARNING: docker not found and nothing listening on :27017."
  echo "[dev]          Start Mongo manually (brew services start mongodb-community,"
  echo "[dev]          or 'docker compose -f src/api/docker-compose.yml up -d mongo')"
  echo "[dev]          and the API will reconnect on its own."
fi

# 2. Bun API (background)
echo "[dev] starting Bun API on :3000 (MAPLE_DEV=1 → proxy to :4201)…"
(
  cd "$REPO_ROOT/src/api"
  PORT=3000 MAPLE_DEV=1 MAPLE_DEV_ORIGIN=http://localhost:4201 \
    bun --watch src/index.ts
) &
API_PID=$!

# 3. Angular dev server (background)
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
       Mongo   localhost:27017         (Docker)

       Open http://localhost:3000 — the API serves the bundle and proxies
       non-/api routes to ng serve so HMR works through one URL.

       Ctrl-C to stop. Mongo keeps running; stop it with:
       docker compose -f src/api/docker-compose.yml down

EOF

wait
