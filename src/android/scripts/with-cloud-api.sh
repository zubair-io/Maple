#!/usr/bin/env bash
# Run a command against a real, disposable Maple API server (src/api) for Android device
# tests. The server gets a fresh SQLite database and library, MAPLE_DEV_AUTH=1 for
# passkey-free sign-in, and is reachable from the device at 127.0.0.1 through adb reverse.
# The command is run with the instrumentation arguments that name it appended:
#   scripts/with-cloud-api.sh ./gradlew connectedDebugAndroidTest
set -euo pipefail
cd "$(dirname "$0")/.."
android="$PWD"
repo="$(cd ../.. && pwd)"
api="$repo/src/api"
port="${MAPLE_API_FIXTURE_PORT:-3988}"
origin="http://127.0.0.1:$port"
work="$(mktemp -d "${TMPDIR:-/tmp}/maple-android-api.XXXXXX")"
library="$work/library"
log="${MAPLE_API_FIXTURE_LOG:-$android/ci-artifacts/api-fixture.log}"
mkdir -p "$library/2026" "$work/runtime" "$(dirname "$log")"
server=''

cleanup() {
	if [[ -n "$server" ]]; then kill "$server" 2>/dev/null || true; fi
	adb reverse --remove "tcp:$port" >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

# Read-only fixtures for browse/open/thumbnail. Without the native engine the server
# cannot render thumbnails, so a fresh shared-cache AVIF is staged beside the originals.
cp "$repo/test-fixtures/batch-transfer/source.dng" "$library/2026/raw.dng"
cp "$repo/test-fixtures/raster-metadata/progressive-444.jpg" "$library/2026/photo.jpg"
printf '%s' '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>' >"$library/2026/raw.xmp"
printf 'Maple provider fixture\n' >"$library/notes.txt"
# Large enough to cancel mid-transfer; sparse, so it costs no host disk.
mkdir -p "$library/large"
python3 -c 'import sys; open(sys.argv[1], "wb").truncate(512 << 20)' "$library/large/large.bin"
mkdir -p "$library/2026/.maple/thumbs"
sleep 1
for name in raw.dng photo.jpg; do
	cp "$repo/test-fixtures/raster-metadata/avif-validation/srgb-rgb.avif" "$library/2026/.maple/thumbs/$name.avif"
done

if [[ ! -d "$api/node_modules" ]]; then (cd "$api" && bun install --frozen-lockfile); fi
native=0
if compgen -G "$api/native/libraw_ffi.*" >/dev/null; then native=1; fi

(
	cd "$api"
	PORT="$port" MAPLE_DEV=0 MAPLE_DEV_AUTH=1 MAPLE_ROOTS="$library" \
		MAPLE_SQLITE_PATH="$work/runtime/maple.sqlite" MAPLE_INDEXER_AUTOSTART=0 \
		MAPLE_JWT_SECRET_FILE="$work/runtime/jwt.secret" MAPLE_BACKUP_TMP="$work/runtime/backup" \
		exec bun src/index.ts
) >"$log" 2>&1 &
server=$!
for ((attempt = 0; attempt < 120; attempt++)); do
	if curl -fsS "$origin/api/health" >/dev/null 2>&1; then break; fi
	if ! kill -0 "$server" 2>/dev/null; then
		cat "$log" >&2
		echo 'Maple API fixture server exited before it was ready' >&2
		exit 1
	fi
	sleep 0.5
done
curl -fsS "$origin/api/health" >/dev/null

json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
token="$(curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' "$origin/api/auth/dev-login" | json "['access_token']")"
folder="$(curl -fsS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
	-d "{\"path\":\"$library\",\"label\":\"Android provider fixture\"}" "$origin/api/folders" | json "['id']")"
curl -fsS -X POST -H "Authorization: Bearer $token" "$origin/api/folders/$folder/scan" >/dev/null
adb reverse "tcp:$port" "tcp:$port"
echo "Maple API fixture: $origin (native engine: $native)"

"$@" \
	"-Pandroid.testInstrumentationRunnerArguments.mapleApiOrigin=$origin" \
	"-Pandroid.testInstrumentationRunnerArguments.mapleApiNative=$native"
