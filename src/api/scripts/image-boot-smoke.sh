#!/usr/bin/env bash
# Boot a built Maple Self Hosted image with its library volume mounted at the
# image's own /app/data, wait for GET /api/health to report a connected
# database, and check the bundled UI and its film LUTs are served (#5495,
# #5497). The image never runs in any other CI job, so a server source file the
# Dockerfile forgets to COPY only shows up here. Native decode helpers start
# lazily and are not exercised.
#
# Usage: src/api/scripts/image-boot-smoke.sh [image] [timeout-seconds] [host-port]
#   image            defaults to maple:ci
#   timeout-seconds  how long to wait for the first healthy response (default 300)
#   host-port        loopback port the container's 3000 is published on (default 3000)

set -euo pipefail

image="${1:-maple:ci}"
timeout_seconds="${2:-300}"
host_port="${3:-3000}"
settle_seconds=20
container="maple-boot-smoke-$$"
data_dir="$(mktemp -d)"
base_url="http://127.0.0.1:${host_port}"
health_url="${base_url}/api/health"
film_lut_id="color_negative_kodak_portra_400"
film_lut_source="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/resources/film-luts/${film_lut_id}.mlut"

command -v jq >/dev/null || {
	echo "image-boot-smoke: jq is required" >&2
	exit 2
}
[[ -s "$film_lut_source" ]] || {
	echo "image-boot-smoke: $film_lut_source is missing" >&2
	exit 2
}

# Lets the runner user delete the root-owned database files the container
# leaves behind.
chmod 0777 "$data_dir"
served_lut="$(mktemp)"

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	rm -rf "$data_dir" "$served_lut" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
	echo "::error::$1"
	echo "----- docker logs $container -----"
	docker logs "$container" 2>&1 || true
	echo "----- end docker logs -----"
	exit 1
}

require_running() {
	local state
	state="$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$container" 2>/dev/null || echo missing)"
	[[ "$state" == running* ]] || fail "container is not running ($state)"
}

# Prints the health body. Returns 1 while the server is not answering yet and
# 2 when it answers without a connected database (a boot that will never heal).
health_body() {
	local body
	body="$(curl -fs --max-time 5 "$health_url")" || return 1
	echo "$body"
	jq -e '.ok == true and .db_connected == true' >/dev/null <<<"$body" || return 2
}

# No restart policy: a crash must leave the container exited so the loop below
# sees it, instead of a restart loop that intermittently answers.
docker run -d --name "$container" \
	-p "127.0.0.1:${host_port}:3000" \
	-v "${data_dir}:/app/data" \
	-e MAPLE_SQLITE_PATH=/app/data/maple.sqlite \
	"$image" >/dev/null

deadline=$((SECONDS + timeout_seconds))
while :; do
	status=0
	body="$(health_body)" || status=$?
	((status != 2)) || fail "/api/health answered without a connected database: $body"
	((status != 0)) || break
	require_running
	((SECONDS < deadline)) || fail "no healthy /api/health response within ${timeout_seconds}s"
	sleep 2
done
echo "healthy ${SECONDS}s after starting: $body"

# Workers and schedulers start after the listener; a crash a few seconds after
# the first healthy answer is still a crash-looping deploy.
sleep "$settle_seconds"
require_running
status=0
body="$(health_body)" || status=$?
((status == 0)) || fail "/api/health unhealthy ${settle_seconds}s after boot: ${body:-no response}"
[[ -f "${data_dir}/maple.sqlite" ]] || fail "no database file was created at MAPLE_SQLITE_PATH"
index_html="$(curl -fs --max-time 10 "${base_url}/")" || index_html=""
[[ "$index_html" == *"<html"* ]] || fail "GET / did not serve the bundled UI's index.html"

# A LUT missing from the UI bundle is not a 404: the SPA fallback answers it
# with index.html, so compare the served bytes with the repository's copy.
lut_url="${base_url}/film-luts/${film_lut_id}.mlut"
lut_content_type="$(curl -fs --max-time 10 -o "$served_lut" -w '%{content_type}' "$lut_url")" ||
	fail "GET $lut_url failed"
[[ "$lut_content_type" != *html* ]] || fail "GET $lut_url served HTML, not the LUT: the UI bundle has no film-luts"
cmp -s "$served_lut" "$film_lut_source" || fail "GET $lut_url did not serve the bytes of $film_lut_source"
echo "still healthy ${settle_seconds}s later; database created; UI and film LUTs served"
