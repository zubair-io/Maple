#!/usr/bin/env bash
# measure_grid_scroll.sh — dropped frames while the Browse grid scrolls, on
# this Mac and on an attached iPad, with no UI automation (#6048).
#
# Usage:
#   src/scripts/measure_grid_scroll.sh [--mac] [--ipad <device name>] [--simulator <name>]
#                                      [--counts "500 2000"] [--runs 5]
#                                      [--build-only | --skip-build] [--out <dir>]
#
# With no target flag it measures the Mac. For each target it builds a Release
# app from this checkout, stages a seed folder from COPIES of the RAW fixtures
# (RAW_DIR, default test-fixtures/raws; the originals are only read), and for
# each photo count launches the app's own scroll run (see
# src/apple/Maple/Views/AppShell+GridScrollRun.swift) RUNS times fresh and
# RUNS times on the folder it just browsed. Each launch writes one JSON report
# with two top-to-bottom passes:
#
#   fresh launch     first  = cold: thumbnails are made while the grid scrolls
#                    cached = warm: same process, every thumbnail cached
#   reopened launch  first  = reopened: new process, thumbnails already on disk
#
# It prints minimum and median dropped frames per case against the limit of
# zero and exits 1 when any case is over it, 2 when a run could not be
# trusted (display asleep or locked, device locked, a run failed).
#
# --build-only / --skip-build split the build from the timing so each can run
# in its own slot on a busy machine.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RAW_DIR="${RAW_DIR:-$REPO/test-fixtures/raws}"
OUT="${TMPDIR:-/tmp}/maple-grid-scroll"
COUNTS="500 2000"
RUNS=5
MAC=0
IPAD=""
SIMULATOR=""
BUILD=1
MEASURE=1
SEED_FILES=(test_0001.RAW test_0002.dng test_0006.DNG test_0008.RAF test_0010.CR2
  test_0011.ARW test_0013.DNG test_0014.NEF test_0015.dng test_0017.dng test_0020.dng
  Lawrence.jpg)
MAC_BUNDLE_ID="app.justmaple.aperture.scrollrun"
IOS_BUNDLE_ID="app.justmaple.aperture"
DEVICE_SEED="Library/Caches/maple-scroll-seed"
DEVICE_REPORT="Library/Caches/maple-scroll-run.json"
LAUNCH_TIMEOUT=1800

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mac) MAC=1 ;;
    --ipad) IPAD="$2"; shift ;;
    --simulator) SIMULATOR="$2"; shift ;;
    --counts) COUNTS="$2"; shift ;;
    --runs) RUNS="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --build-only) MEASURE=0 ;;
    --skip-build) BUILD=0 ;;
    *) sed -n '2,32p' "${BASH_SOURCE[0]}" >&2; exit 64 ;;
  esac
  shift
done
[[ $MAC == 0 && -z "$IPAD" && -z "$SIMULATOR" ]] && MAC=1

mkdir -p "$OUT/reports" "$OUT/logs"
SEED="$OUT/seed"
MAC_APP="$OUT/mac/Maple.app"
PROJECT="$REPO/src/apple/Maple.xcodeproj"

blocker() { echo "BLOCKED: $*" >&2; exit 2; }

stage_seed() {
  rm -rf "$SEED"; mkdir -p "$SEED"
  local missing=()
  for name in "${SEED_FILES[@]}"; do
    if [[ -f "$RAW_DIR/$name" ]]; then cp -c "$RAW_DIR/$name" "$SEED/$name" 2>/dev/null || cp "$RAW_DIR/$name" "$SEED/$name"
    else missing+=("$name"); fi
  done
  [[ ${#missing[@]} == 0 ]] || blocker "RAW fixtures missing from $RAW_DIR: ${missing[*]}"
}

build() {
  local destination="$1" derived="$2"; shift 2
  xcodebuild -project "$PROJECT" -scheme Maple -configuration Release \
    -destination "$destination" -derivedDataPath "$derived" "$@" build \
    > "$OUT/logs/build-$(basename "$derived").log" 2>&1 \
    || { tail -40 "$OUT/logs/build-$(basename "$derived").log" >&2; exit 1; }
}

# The measured Mac app is a copy with its own bundle identifier, so it never
# reads or writes the installed app's settings, caches or recent folders.
package_mac() {
  local built="$OUT/dd-mac/Build/Products/Release/Maple.app"
  rm -rf "$OUT/mac"; mkdir -p "$OUT/mac"
  cp -R "$built" "$MAC_APP"
  rm -rf "$MAC_APP/Contents/PlugIns" "$MAC_APP/Contents/Library" \
    "$MAC_APP/Contents/embedded.provisionprofile"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $MAC_BUNDLE_ID" "$MAC_APP/Contents/Info.plist"
  cat > "$OUT/mac/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>
PLIST
  codesign --force --deep --sign - --entitlements "$OUT/mac/entitlements.plist" "$MAC_APP" 2>/dev/null
}

# The app's own report says whether the display was awake; a locked screen is
# worth refusing before a twenty-minute run.
mac_screen_unlocked() {
  ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers json -o - - | python3 -c '
import json, sys
console = [user for user in json.load(sys.stdin) if user.get("kCGSSessionOnConsoleKey")]
sys.exit(0 if console and not any(user.get("CGSSessionScreenIsLocked") for user in console) else 1)'
}

run_mac() {
  local count="$1" kind="$2" report="$3"
  rm -f "$report"
  local reuse=0; [[ $kind == reopen ]] && reuse=1
  open -n -W -a "$MAC_APP" --env "MAPLE_SCROLL_RUN_SEED=$SEED" \
    --env "MAPLE_SCROLL_RUN_COUNT=$count" --env "MAPLE_SCROLL_RUN_REPORT=$report" \
    --env "MAPLE_SCROLL_RUN_REUSE=$reuse" &
  local pid=$! waited=0
  while kill -0 $pid 2>/dev/null && (( waited < LAUNCH_TIMEOUT )); do sleep 1; waited=$((waited + 1)); done
  if kill -0 $pid 2>/dev/null; then
    pkill -f "$MAC_APP/Contents/MacOS/" || true
    kill $pid 2>/dev/null || true
  fi
  wait $pid 2>/dev/null || true
}

device_id() {
  xcrun devicectl list devices 2>/dev/null \
    | awk -v name="$1" 'index($0, name) == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F-]{20,}$/) print $i }' \
    | head -1
}

run_ipad() {
  local udid="$1" count="$2" kind="$3" report="$4"
  rm -f "$report"
  local reuse=0; [[ $kind == reopen ]] && reuse=1
  xcrun devicectl device process launch --device "$udid" --console --terminate-existing \
    --timeout "$LAUNCH_TIMEOUT" --environment-variables \
    "{\"MAPLE_SCROLL_RUN_SEED\":\"$DEVICE_SEED\",\"MAPLE_SCROLL_RUN_COUNT\":\"$count\",\"MAPLE_SCROLL_RUN_REPORT\":\"$DEVICE_REPORT\",\"MAPLE_SCROLL_RUN_REUSE\":\"$reuse\"}" \
    "$IOS_BUNDLE_ID" >> "$OUT/logs/ipad-launch.log" 2>&1 || true
  xcrun devicectl device copy from --device "$udid" --domain-type appDataContainer \
    --domain-identifier "$IOS_BUNDLE_ID" --source "$DEVICE_REPORT" --destination "$report" \
    >> "$OUT/logs/ipad-launch.log" 2>&1 || true
}

run_simulator() {
  local udid="$1" count="$2" kind="$3" report="$4"
  rm -f "$report"
  local reuse=0; [[ $kind == reopen ]] && reuse=1
  local home; home="$(xcrun simctl get_app_container "$udid" "$IOS_BUNDLE_ID" data)"
  rm -rf "$home/$DEVICE_SEED"; mkdir -p "$home/$(dirname "$DEVICE_SEED")"
  cp -R "$SEED" "$home/$DEVICE_SEED"
  SIMCTL_CHILD_MAPLE_SCROLL_RUN_SEED="$DEVICE_SEED" SIMCTL_CHILD_MAPLE_SCROLL_RUN_COUNT="$count" \
    SIMCTL_CHILD_MAPLE_SCROLL_RUN_REPORT="$DEVICE_REPORT" SIMCTL_CHILD_MAPLE_SCROLL_RUN_REUSE="$reuse" \
    xcrun simctl launch --console --terminate-running-process "$udid" "$IOS_BUNDLE_ID" \
    >> "$OUT/logs/simulator-launch.log" 2>&1 || true
  cp "$home/$DEVICE_REPORT" "$report" 2>/dev/null || true
}

measure() {
  local target="$1"; shift
  for count in $COUNTS; do
    for run in $(seq 1 "$RUNS"); do
      for kind in fresh reopen; do
        "$@" "$count" "$kind" "$OUT/reports/$target-$count-$kind-$run.json"
        echo "$target $count photos, $kind launch $run/$RUNS done" >&2
      done
    done
  done
}

stage_seed

if [[ $MAC == 1 ]]; then
  if [[ $BUILD == 1 ]]; then build 'platform=macOS,arch=arm64' "$OUT/dd-mac"; package_mac; fi
  if [[ $MEASURE == 1 ]]; then
    [[ -d "$MAC_APP" ]] || blocker "no built Mac app at $MAC_APP; run without --skip-build first"
    mac_screen_unlocked || blocker "this Mac's screen is locked, so no frame is presented. Unlock it and run again."
    rm -f "$OUT"/reports/mac-*.json
    measure mac run_mac
  fi
fi

if [[ -n "$IPAD" ]]; then
  UDID="$(device_id "$IPAD")"
  [[ -n "$UDID" ]] || blocker "no paired device named '$IPAD' in: xcrun devicectl list devices"
  xcrun devicectl device info details --device "$UDID" > "$OUT/logs/ipad-details.log" 2>&1 \
    || blocker "'$IPAD' is locked or unreachable. Unlock it, keep it awake on this network, and run again."
  if [[ $BUILD == 1 ]]; then
    build "platform=iOS,id=$UDID" "$OUT/dd-ipad" -allowProvisioningUpdates
    xcrun devicectl device install app --device "$UDID" \
      "$OUT/dd-ipad/Build/Products/Release-iphoneos/Maple.app" > "$OUT/logs/ipad-install.log" 2>&1 \
      || blocker "could not install on '$IPAD' (see $OUT/logs/ipad-install.log)"
  fi
  if [[ $MEASURE == 1 ]]; then
    xcrun devicectl device copy to --device "$UDID" --domain-type appDataContainer \
      --domain-identifier "$IOS_BUNDLE_ID" --source "$SEED" --destination "$DEVICE_SEED" \
      > "$OUT/logs/ipad-seed.log" 2>&1 \
      || blocker "could not copy the seed folder to '$IPAD' (see $OUT/logs/ipad-seed.log)"
    rm -f "$OUT"/reports/ipad-*.json
    measure ipad run_ipad "$UDID"
  fi
fi

if [[ -n "$SIMULATOR" ]]; then
  SIM_UDID="$(xcrun simctl list devices available | awk -v name="$SIMULATOR (" 'index($0, name) { print }' | grep -oE '[0-9A-F-]{36}' | head -1)"
  [[ -n "$SIM_UDID" ]] || blocker "no simulator named '$SIMULATOR'"
  xcrun simctl bootstatus "$SIM_UDID" -b > /dev/null
  if [[ $BUILD == 1 ]]; then
    build "platform=iOS Simulator,id=$SIM_UDID" "$OUT/dd-simulator"
    xcrun simctl install "$SIM_UDID" "$OUT/dd-simulator/Build/Products/Release-iphonesimulator/Maple.app"
  fi
  if [[ $MEASURE == 1 ]]; then
    rm -f "$OUT"/reports/simulator-*.json
    measure simulator run_simulator "$SIM_UDID"
  fi
fi

[[ $MEASURE == 1 ]] || exit 0

python3 - "$OUT" "$RUNS" <<'PY'
import glob, json, os, re, statistics, sys

out, runs = sys.argv[1], int(sys.argv[2])
cases = {"fresh": [("first", "cold"), ("cached", "warm")], "reopen": [("first", "reopened")]}
rows, untrusted, over = {}, [], False
for path in sorted(glob.glob(os.path.join(out, "reports", "*.json"))):
    target, count, kind, run = re.match(r"(.+)-(\d+)-(fresh|reopen)-(\d+)\.json", os.path.basename(path)).groups()
    report = json.load(open(path))
    visible = report["displayAwake"] and report["windowVisible"] and not report["screenLocked"]
    if report.get("error") or not visible or (kind == "reopen" and not report["reusedFolder"]):
        untrusted.append(f"{os.path.basename(path)}: {report.get('error') or ('frames not visible' if not visible else 'folder was not reused')}")
        continue
    passes = {p["name"]: p for p in report["passes"]}
    for name, label in cases[kind]:
        rows.setdefault((target, int(count), label), []).append((passes[name]["stats"], report))

print(f"{'target':<10}{'photos':>7}  {'case':<9}{'runs':>5}  {'dropped min/med':>16}  {'longest stall ms':>17}  {'stall ms/s med':>15}  {'Hz':>4}  {'load':>11}  limit 0")
for (target, count, label) in sorted(rows):
    samples = rows[(target, count, label)]
    dropped = [s["framesDropped"] for s, _ in samples]
    stall = [s["longestStallMs"] for s, _ in samples]
    ratio = [s["stallMsPerSecond"] for s, _ in samples]
    loads = [r["loadAverageAtStart"] for _, r in samples]
    verdict = "met" if max(dropped) == 0 else "NOT MET"
    over = over or max(dropped) > 0
    print(f"{target:<10}{count:>7}  {label:<9}{len(samples):>5}  {min(dropped):>7} / {statistics.median(dropped):<6g}  {max(stall):>17.0f}  {statistics.median(ratio):>15.1f}  {samples[0][0]['refreshHz']:>4.0f}  {min(loads):>4.0f} - {max(loads):<4.0f}  {verdict}")
    if len(samples) < runs:
        untrusted.append(f"{target} {count} {label}: only {len(samples)} of {runs} runs produced a report")

for line in untrusted:
    print("UNTRUSTED:", line)
if not rows:
    print("UNTRUSTED: no run produced a report")
sys.exit(2 if untrusted or not rows else 1 if over else 0)
PY
