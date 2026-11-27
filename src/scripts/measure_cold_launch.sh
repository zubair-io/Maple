#!/usr/bin/env bash
# measure_cold_launch.sh <Maple.app> — target: a cold launch of the Mac app has the
# last folder browsable (grid published) in under 1 s from process start.
#
# Runs an isolated copy of the given Release build: extensions, launch agents and the
# provisioning profile removed, bundle id app.justmaple.aperture.perfaudit, ad-hoc
# signed, so it never reads or writes the owner's Maple settings, caches or library.
# Its saved source is a 2,000-photo folder of APFS clones of the fixture RAWs with
# their shared thumbnails. Each run reads the LaunchTimeline milestones from the
# unified log, then the copy's settings, caches and folder are removed. Prints every
# run, then minimum and median against the limit; exits 1 when the median is over it.
#
# Build the app first, for example:
#   xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -configuration Release \
#     -destination 'platform=macOS' -derivedDataPath /tmp/maple-dd CLANG_COVERAGE_MAPPING=NO build
# Env: RAW_DIR, RUNS (default 5), PHOTOS (default 2000), LIMIT_MS (default 1000).
set -euo pipefail

built_app=${1:?usage: measure_cold_launch.sh <path to a Release Maple.app>}
repo=$(cd "$(dirname "$0")/../.." && pwd)
runs=${RUNS:-5}
photos=${PHOTOS:-2000}
limit_ms=${LIMIT_MS:-1000}
bundle_id=app.justmaple.aperture.perfaudit
raw_dir=${RAW_DIR:-$repo/test-fixtures/raws}
if [[ ! -d $raw_dir ]]; then
	raw_dir=$(cd "$(git -C "$repo" rev-parse --git-common-dir)/.." && pwd)/test-fixtures/raws
fi
[[ -d $raw_dir ]] || {
	echo "no fixture RAWs at $raw_dir; set RAW_DIR" >&2
	exit 2
}

work=$(mktemp -d "${TMPDIR:-/tmp}/maple-cold-launch.XXXXXX")
app=$work/Maple.app
quit_app() {
	local pids
	pids=$(pgrep -f "^$app/Contents/MacOS/Maple" || true)
	[[ -z $pids ]] || kill $pids 2>/dev/null || true
	sleep 1
}
clean_up() {
	quit_app
	defaults delete "$bundle_id" >/dev/null 2>&1 || true
	rm -rf "$HOME/Library/Caches/$bundle_id" "$HOME/Library/Application Support/$bundle_id" \
		"$HOME/Library/Saved Application State/$bundle_id.savedState" "$work"
}
trap clean_up EXIT

cp -R "$built_app" "$app"
rm -rf "$app/Contents/PlugIns" "$app/Contents/Library" "$app/Contents/embedded.provisionprofile"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$app/Contents/Info.plist"
cat >"$work/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>
PLIST
codesign --force --deep --sign - --entitlements "$work/entitlements.plist" "$app" 2>/dev/null

folder=$work/folder
mkdir -p "$folder/.maple/thumbs"
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

cat >"$work/seed.swift" <<'SWIFT'
import Foundation
enum SourceSelection: Codable { case filesystem(bookmark: Data) }
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let bookmark = try folder.bookmarkData(
  options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
let defaults = UserDefaults(suiteName: CommandLine.arguments[2])!
defaults.set(
  try JSONEncoder().encode(SourceSelection.filesystem(bookmark: bookmark)),
  forKey: "app.justmaple.aperture.lastSource")
defaults.synchronize()
SWIFT
swiftc -O -o "$work/seed" "$work/seed.swift" 2>/dev/null
"$work/seed" "$folder" "$bundle_id"
echo "app: $built_app; folder: $photos clones of ${#sources[@]} fixtures"

milestone() { sed -nE "s/.*$1 at ([0-9]+) ms.*/\1/p" "$2" | head -1; }
published=()
for ((r = 1; r <= runs; r++)); do
	quit_app
	log=$work/launch-$r.log
	/usr/bin/log stream --style compact --level info \
		--predicate 'subsystem == "app.justmaple.aperture" AND category == "launch"' >"$log" 2>&1 &
	stream=$!
	sleep 1.5
	open -n -a "$app" --args -ApplePersistenceIgnoreState YES
	for ((t = 0; t < 60; t++)); do
		grep -q firstThumbnail "$log" && break
		sleep 0.5
	done
	sleep 1
	kill "$stream" 2>/dev/null || true
	quit_app
	grid=$(milestone gridPublished "$log")
	[[ -n $grid ]] || {
		echo "run=$r: no gridPublished milestone; log: $(head -c 400 "$log")" >&2
		exit 1
	}
	published+=("$grid")
	echo "run=$r load1=$(sysctl -n vm.loadavg | awk '{print $2}') shellAppeared=$(milestone shellAppeared "$log") gridPublished=$grid firstThumbnail=$(milestone firstThumbnail "$log") ms"
done

read -r grid_min grid_median <<<"$(printf '%s\n' "${published[@]}" | sort -n |
	awk '{v[NR]=$1} END {print v[1], v[int((NR+1)/2)]}')"
echo "last folder browsable: min ${grid_min} ms, median ${grid_median} ms (limit ${limit_ms} ms)"
if ((grid_median > limit_ms)); then
	echo "FAIL: median ${grid_median} ms is over ${limit_ms} ms"
	exit 1
fi
echo "PASS"
