#!/usr/bin/env bash
# measure_lan_thumbnails.sh — target: a 2,000-photo cloud folder has every grid
# thumbnail on the device in under 2 s over the LAN route.
#
# Builds a library of APFS clones of the fixture RAWs (never the originals) with
# their shared 512 px thumbnails, serves it through the production folder and thumb
# routes (src/api/tests/fixtures/folder-thumb-throughput-server.ts) and runs
# FolderThumbnailThroughputTests' LAN case: one discarded warm-up pass, then RUNS
# passes with the app's thumbnail caches emptied. Prints every run, then minimum and
# median of "all bytes on device" against the limit, and exits 1 when the median is
# over it. Decoding every tile is reported too (decision 25), not gated.
#
# Env: RAW_DIR (fixture RAWs; default test-fixtures/raws, else the main checkout's),
#      RUNS (default 5), PHOTOS (default 2000), LIMIT_MS (default 2000), WORK_DIR.
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

work=${WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/maple-lan-thumbs.XXXXXX")}
trap 'rm -rf "$work"' EXIT
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
		MAPLE_PERF_CLOUD_LIBRARY=$work/library MAPLE_PERF_CLOUD_FOLDER=Shoot MAPLE_PERF_PASS=cold \
			swift test -c release --filter FolderThumbnailThroughputTests/testCloudFolderIsFullyThumbnailedOverLAN \
			>"$log" 2>&1) || {
		echo "$label: test failed, see $log" >&2
		grep -m3 -E 'error|failed' "$log" >&2
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
	load=$(sysctl -n vm.loadavg | awk '{print $2}')
	echo "run=$r load1=$load ${line#THROUGHPUT }"
	bytes+=("$(sed -E 's/.*bytes_ms=([0-9]+).*/\1/' <<<"$line")")
	decoded+=("$(sed -E 's/.*total_ms=([0-9]+).*/\1/' <<<"$line")")
done

stats() { printf '%s\n' "$@" | sort -n | awk '{v[NR]=$1} END {print v[1], v[int((NR+1)/2)]}'; }
read -r bytes_min bytes_median <<<"$(stats "${bytes[@]}")"
read -r all_min all_median <<<"$(stats "${decoded[@]}")"
echo "all bytes on device: min ${bytes_min} ms, median ${bytes_median} ms (limit ${limit_ms} ms)"
echo "every tile decoded:  min ${all_min} ms, median ${all_median} ms (not gated, decision 25)"
if ((bytes_median > limit_ms)); then
	echo "FAIL: median ${bytes_median} ms is over ${limit_ms} ms"
	exit 1
fi
echo "PASS"
