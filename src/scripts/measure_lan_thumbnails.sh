#!/usr/bin/env bash
# measure_lan_thumbnails.sh — target: a 2,000-photo cloud folder has every grid
# thumbnail on the device in under 2 s over the LAN route.
#
# The server runs on this Mac and is reached over loopback (127.0.0.1), so this
# measures the app's LAN-route code (listing, 16-wide fetch, disk cache, decode) and
# the server's production routes, not Wi-Fi or Ethernet latency and bandwidth. A real
# network adds per-request round trips on top; qualify it separately on a device.
#
# Builds a library of APFS clones of the fixture RAWs (never the originals) with
# their shared 512 px thumbnails, serves it through the production folder and thumb
# routes (src/api/tests/fixtures/folder-thumb-throughput-server.ts) and runs
# FolderThumbnailThroughputTests' LAN case: one discarded warm-up pass, then RUNS
# passes with the app's thumbnail caches emptied. Prints every run, then minimum and
# median of "all bytes on device" against the limit, and exits 1 when the median is
# over it. Decoding every tile is reported too (decision 25), not gated.
#
# The test process runs with CFFIXED_USER_HOME pointing into the run's temp folder, so
# the thumbnails and HTTP cache it writes land there and are removed with it; nothing
# under the real ~/Library is written or deleted.
#
# Env: RAW_DIR (fixture RAWs; default test-fixtures/raws, else the main checkout's),
#      RUNS (default 5), PHOTOS (default 2000), LIMIT_MS (default 2000).
# Needs: bun with src/api dependencies installed (cd src/api && bun install), and the
# release xcframework (src/apple/scripts/build-xcframework.sh).
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
runs=${RUNS:-5}
photos=${PHOTOS:-2000}
limit_ms=${LIMIT_MS:-2000}
raw_dir=${RAW_DIR:-$repo/test-fixtures/raws}
if [[ ! -d $raw_dir ]]; then
	raw_dir=$(cd "$(git -C "$repo" rev-parse --git-common-dir)/.." && pwd)/test-fixtures/raws
fi
[[ -d $raw_dir ]] || {
	echo "no fixture RAWs at $raw_dir; set RAW_DIR" >&2
	exit 2
}
[[ -d $repo/src/api/node_modules ]] || {
	echo "run: cd src/api && bun install" >&2
	exit 2
}

work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/maple-lan-thumbs.XXXXXX")" && pwd -P)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home"
[[ $(stat -f %d "$raw_dir") == "$(stat -f %d "$work")" ]] || {
	echo "$raw_dir and $work are on different volumes; cp -c would copy in full" >&2
	exit 2
}
folder=$work/library/Shoot
mkdir -p "$folder/.maple/thumbs" "$work/logs"

sources=()
while IFS= read -r name; do sources+=("$name"); done < <(
	cd "$raw_dir" && for f in *; do
		[[ -f $f && -f .maple/thumbs/$f.avif && $f != *.xmp ]] && echo "$f"
	done | grep -viE 'pano|100mp' || true
)
((${#sources[@]} > 0)) || {
	echo "no fixture in $raw_dir has a shared thumbnail" >&2
	exit 2
}
for ((i = 0; i < photos; i++)); do
	src=${sources[i % ${#sources[@]}]}
	name=$(printf 'IMG_%04d.%s' "$i" "${src##*.}")
	cp -c "$raw_dir/$src" "$folder/$name"
	cp -c "$raw_dir/.maple/thumbs/$src.avif" "$folder/.maple/thumbs/$name.avif"
done
echo "library: $photos clones of ${#sources[@]} fixtures in $folder"

run_pass() {
	local label=$1 log=$work/logs/$1.log
	(cd "$repo/src/apple/Packages/MapleCore" &&
		CFFIXED_USER_HOME=$work/home MAPLE_PERF_CLOUD_LIBRARY=$work/library MAPLE_PERF_CLOUD_FOLDER=Shoot MAPLE_PERF_PASS=cold \
			swift test -c release --filter FolderThumbnailThroughputTests/testCloudFolderIsFullyThumbnailedOverLAN \
			>"$log" 2>&1) || {
		echo "$label: test failed, see $log" >&2
		grep -m3 -E 'error|failed' "$log" >&2 || true
		return 1
	}
	grep -m1 THROUGHPUT "$log" || {
		echo "$label: no THROUGHPUT line in $log" >&2
		return 1
	}
}

run_pass warmup >/dev/null
bytes=() decoded=()
for ((r = 1; r <= runs; r++)); do
	line=$(run_pass "run$r")
	[[ $line == *" photos=$photos decoded=$photos "* ]] || {
		echo "run=$r: expected $photos photos listed and decoded, got: ${line#THROUGHPUT }" >&2
		exit 1
	}
	load=$(sysctl -n vm.loadavg | awk '{print $2}')
	echo "run=$r load1=$load ${line#THROUGHPUT }"
	bytes+=("$(sed -E 's/.*bytes_ms=([0-9]+).*/\1/' <<<"$line")")
	decoded+=("$(sed -E 's/.*total_ms=([0-9]+).*/\1/' <<<"$line")")
done

stats() { printf '%s\n' "$@" | sort -n | awk '{v[NR]=$1} END {print v[1], v[int((NR+1)/2)]}'; }
read -r bytes_min bytes_median <<<"$(stats "${bytes[@]}")"
read -r all_min all_median <<<"$(stats "${decoded[@]}")"
echo "all bytes on device (loopback): min ${bytes_min} ms, median ${bytes_median} ms (limit ${limit_ms} ms)"
echo "every tile decoded:  min ${all_min} ms, median ${all_median} ms (not gated, decision 25)"
if ((bytes_median > limit_ms)); then
	echo "FAIL: median ${bytes_median} ms is over ${limit_ms} ms"
	exit 1
fi
echo "PASS"
