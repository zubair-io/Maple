#!/usr/bin/env bash
# measure_grid_scroll.sh — dropped frames while the Browse grid scrolls, on
# this Mac, an attached iPad or an iOS simulator, with no UI automation (#6048).
#
# Usage:
#   src/scripts/measure_grid_scroll.sh [--mac] [--ipad <device name>] [--simulator <name>]
#                                      [--counts "500 2000"] [--runs 5]
#                                      [--build-only | --skip-build] [--out <dir>]
#   src/scripts/measure_grid_scroll.sh --screen-check [--skip-build] [--out <dir>]
#
# With no target flag it measures the Mac. For each target it builds a Release
# app from this checkout, stages a seed folder from COPIES of the RAW fixtures
# (RAW_DIR, default test-fixtures/raws; the RAWs are only read), and for each
# photo count launches the app's own scroll run (see
# src/apple/Maple/Views/AppShell+GridScrollRun.swift) RUNS times fresh and
# RUNS times on the folder it just browsed. Each launch writes one JSON report
# with two top-to-bottom passes:
#
#   fresh launch     first  = cold: thumbnails are made while the grid scrolls
#                    cached = warm: same process, every thumbnail cached
#   reopened launch  first  = reopened: new process, thumbnails already on disk
#
# It prints minimum, median and maximum dropped frames per case against the
# limit of zero. Exit status: 0 every case met the limit, 1 a case is over
# it, 2 a run could not be trusted or a step failed (locked screen or device,
# a missing report, low-power mode, a display running below its rate), 64
# bad arguments.
#
# What it touches besides its own output folder:
#   * The Mac app it measures is a re-signed copy with its own bundle
#     identifier and no sandbox or app-group entitlement, so it has its own
#     preferences and caches. The iPad and simulator runs use the real bundle
#     identifier: the build is installed over the app already on the device
#     (its data is kept, and the throwaway folder never becomes a recent
#     folder), and a running copy is terminated.
#   * Like every build of the app, the build removes *.xmp sidecars and .maple
#     folders under this checkout's test-fixtures/raws.
#
# --screen-check cross-checks the app's counter instead of measuring: one
# 500-photo Mac launch is recorded by the system's screen-capture stream
# (grid_scroll_screen_capture.swift, needs Screen Recording permission), and
# the refreshes on which the window's picture changed are printed next to the
# app's count for the cached pass. The first pass is not compared: loading
# placeholders animate on their own, so the picture changes there even when
# the scroll did not advance.
#
# --build-only / --skip-build split the build from the timing so each can run
# in its own slot on a busy machine.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
RAW_DIR="${RAW_DIR:-$REPO/test-fixtures/raws}"
OUT="${TMPDIR:-/tmp}/maple-grid-scroll"
COUNTS="500 2000"
RUNS=5
MAC=0
IPAD=""
SIMULATOR=""
BUILD=1
MEASURE=1
SCREEN_CHECK=0
SEED_FILES=(test_0001.RAW test_0002.dng test_0006.DNG test_0008.RAF test_0010.CR2
  test_0011.ARW test_0013.DNG test_0014.NEF test_0015.dng test_0017.dng test_0020.dng
  Lawrence.jpg)
MAC_BUNDLE_ID="app.justmaple.aperture.scrollrun"
IOS_BUNDLE_ID="app.justmaple.aperture"
DEVICE_SEED="Library/Caches/maple-scroll-seed"
LAUNCH_TIMEOUT=1800

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" >&2; exit 64; }
blocker() { echo "BLOCKED: $*" >&2; exit 2; }
positive_integers() {
  local value
  for value in "$@"; do [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1; done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mac) MAC=1 ;;
    --build-only) MEASURE=0 ;;
    --skip-build) BUILD=0 ;;
    --screen-check) SCREEN_CHECK=1; MAC=1 ;;
    --ipad|--simulator|--counts|--runs|--out)
      [[ $# -ge 2 && -n "$2" ]] || usage
      case "$1" in
        --ipad) IPAD="$2" ;;
        --simulator) SIMULATOR="$2" ;;
        --counts) COUNTS="$2" ;;
        --runs) RUNS="$2" ;;
        --out) OUT="$2" ;;
      esac
      shift ;;
    *) usage ;;
  esac
  shift
done
# shellcheck disable=SC2086
positive_integers $COUNTS && [[ -n "$COUNTS" ]] || usage
positive_integers "$RUNS" || usage
[[ $BUILD == 1 || $MEASURE == 1 ]] || usage
[[ $SCREEN_CHECK == 0 || ( -z "$IPAD" && -z "$SIMULATOR" ) ]] || usage
[[ $MAC == 0 && -z "$IPAD" && -z "$SIMULATOR" ]] && MAC=1

mkdir -p "$OUT/reports" "$OUT/logs"
OUT="$(cd "$OUT" && pwd -P)"
[[ -d "$RAW_DIR" ]] || blocker "no RAW fixtures at $RAW_DIR (set RAW_DIR)"
RAW_DIR="$(cd "$RAW_DIR" && pwd -P)"
case "$RAW_DIR/" in "$OUT"/*) blocker "RAW_DIR must not be inside the output folder $OUT" ;; esac
SEED="$OUT/seed"
MAC_APP="$OUT/mac/Maple.app"
PROJECT="$REPO/src/apple/Maple.xcodeproj"
TARGETS=""

stage_seed() {
  rm -rf "$SEED"; mkdir -p "$SEED"
  local missing=() name
  for name in "${SEED_FILES[@]}"; do
    if [[ -f "$RAW_DIR/$name" ]]; then
      cp -c "$RAW_DIR/$name" "$SEED/$name" 2>/dev/null || cp "$RAW_DIR/$name" "$SEED/$name"
    else
      missing+=("$name")
    fi
  done
  [[ ${#missing[@]} == 0 ]] || blocker "RAW fixtures missing from $RAW_DIR: ${missing[*]}"
}

# The scheme gathers test coverage, which instruments every build made through
# it, Release included; the shipped archive is not instrumented, so the
# measured app must not be either.
build() {
  local destination="$1" derived="$2" log
  shift 2
  log="$OUT/logs/build-$(basename "$derived").log"
  xcodebuild -project "$PROJECT" -scheme Maple -configuration Release \
    -destination "$destination" -derivedDataPath "$derived" CLANG_COVERAGE_MAPPING=NO "$@" build \
    > "$log" 2>&1 || { tail -40 "$log" >&2; blocker "the build failed (see $log)"; }
  if nm "$derived"/Build/Products/Release*/Maple.app/Maple \
    "$derived"/Build/Products/Release*/Maple.app/Contents/MacOS/Maple 2>/dev/null \
    | grep -q '___llvm_profile_runtime'; then
    blocker "the built app carries coverage instrumentation, so its timings would not be the shipped app's"
  fi
}

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
  codesign --force --deep --sign - --entitlements "$OUT/mac/entitlements.plist" "$MAC_APP" \
    > "$OUT/logs/codesign.log" 2>&1 || blocker "could not sign the measured copy (see $OUT/logs/codesign.log)"
}

# The app's own report says whether the display was awake; a locked screen is
# worth refusing before a twenty-minute run.
mac_screen_unlocked() {
  ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers json -o - - | python3 -c '
import json, sys
console = [user for user in json.load(sys.stdin) if user.get("kCGSSessionOnConsoleKey")]
sys.exit(0 if console and not any(user.get("CGSSessionScreenIsLocked") for user in console) else 1)'
}

mac_app_pid() {
  ps -axo pid=,command= | awk -v binary="$MAC_APP/Contents/MacOS/Maple" \
    'index($0, binary) { print $1; exit }'
}

# Waits for `waiter` to exit, and after LAUNCH_TIMEOUT seconds stops the app
# whose process id `find_pid` prints.
wait_or_stop() {
  local waiter="$1" find_pid="$2" waited=0 app
  while kill -0 "$waiter" 2>/dev/null && (( waited < LAUNCH_TIMEOUT )); do
    sleep 1; waited=$((waited + 1))
  done
  if kill -0 "$waiter" 2>/dev/null; then
    app="$($find_pid || true)"
    [[ -z "$app" ]] || kill "$app" 2>/dev/null || true
    kill "$waiter" 2>/dev/null || true
  fi
  wait "$waiter" 2>/dev/null || true
}

run_mac() {
  local count="$1" kind="$2" run="$3" report="$4" reuse=0
  [[ $kind == reopen ]] && reuse=1
  rm -f "$report"
  open -n -W -a "$MAC_APP" --env "MAPLE_SCROLL_RUN_SEED=$SEED" \
    --env "MAPLE_SCROLL_RUN_COUNT=$count" --env "MAPLE_SCROLL_RUN_REPORT=$report" \
    --env "MAPLE_SCROLL_RUN_REUSE=$reuse" &
  wait_or_stop $! mac_app_pid
}

physical_device_id() {
  xcrun devicectl list devices 2>/dev/null | awk -v name="$1" '
    $NF == "physical" && index($0, name) == 1 && substr($0, length(name) + 1, 2) == "  " {
      for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]+-[0-9A-F-]+$/) { print $i; exit }
    }'
}

run_ipad() {
  local udid="$1" count="$2" kind="$3" run="$4" report="$5" reuse=0
  local remote="Library/Caches/maple-scroll-run-$count-$kind-$run.json"
  [[ $kind == reopen ]] && reuse=1
  rm -f "$report"
  xcrun devicectl device process launch --device "$udid" --console --terminate-existing \
    --timeout "$LAUNCH_TIMEOUT" --environment-variables \
    "{\"MAPLE_SCROLL_RUN_SEED\":\"$DEVICE_SEED\",\"MAPLE_SCROLL_RUN_COUNT\":\"$count\",\"MAPLE_SCROLL_RUN_REPORT\":\"$remote\",\"MAPLE_SCROLL_RUN_REUSE\":\"$reuse\"}" \
    "$IOS_BUNDLE_ID" >> "$OUT/logs/ipad-launch.log" 2>&1 || true
  xcrun devicectl device copy from --device "$udid" --domain-type appDataContainer \
    --domain-identifier "$IOS_BUNDLE_ID" --source "$remote" --destination "$report" \
    >> "$OUT/logs/ipad-launch.log" 2>&1 || true
}

simulator_app_pid() {
  xcrun simctl spawn "$SIM_UDID" launchctl list 2>/dev/null \
    | awk -v id="UIKitApplication:$IOS_BUNDLE_ID" 'index($3, id) == 1 && $1 != "-" { print $1; exit }'
}

run_simulator() {
  local count="$1" kind="$2" run="$3" report="$4" reuse=0
  local remote="Library/Caches/maple-scroll-run-$count-$kind-$run.json"
  [[ $kind == reopen ]] && reuse=1
  rm -f "$report"
  SIMCTL_CHILD_MAPLE_SCROLL_RUN_SEED="$DEVICE_SEED" SIMCTL_CHILD_MAPLE_SCROLL_RUN_COUNT="$count" \
    SIMCTL_CHILD_MAPLE_SCROLL_RUN_REPORT="$remote" SIMCTL_CHILD_MAPLE_SCROLL_RUN_REUSE="$reuse" \
    xcrun simctl launch --console --terminate-running-process "$SIM_UDID" "$IOS_BUNDLE_ID" \
    >> "$OUT/logs/simulator-launch.log" 2>&1 &
  wait_or_stop $! simulator_app_pid
  cp "$SIM_HOME/$remote" "$report" 2>/dev/null || true
}

measure() {
  local target="$1" count run kind
  shift
  TARGETS="$TARGETS $target"
  rm -f "$OUT"/reports/"$target"-*.json
  for count in $COUNTS; do
    for run in $(seq 1 "$RUNS"); do
      for kind in fresh reopen; do
        "$@" "$count" "$kind" "$run" "$OUT/reports/$target-$count-$kind-$run.json"
        echo "$target $count photos, $kind launch $run/$RUNS finished" >&2
      done
    done
  done
}

screen_check() {
  local report="$OUT/reports/screencheck.json" frames="$OUT/screen-frames.txt" capture
  swiftc -O -swift-version 5 -o "$OUT/screen_capture" \
    "$REPO/src/scripts/grid_scroll_screen_capture.swift" 2> "$OUT/logs/screen-capture-build.log" \
    || blocker "the screen-capture helper did not compile (see $OUT/logs/screen-capture-build.log)"
  rm -f "$frames"
  "$OUT/screen_capture" "$MAC_BUNDLE_ID" "$LAUNCH_TIMEOUT" "$frames" 2> "$OUT/logs/screen-capture.log" &
  capture=$!
  run_mac 500 fresh 1 "$report"
  wait $capture || blocker "screen capture failed: $(tail -1 "$OUT/logs/screen-capture.log"). The terminal needs Screen Recording permission."
  python3 - "$report" "$frames" <<'PY'
import json, math, statistics, sys

def untrusted(reason):
    print("UNTRUSTED:", reason)
    sys.exit(2)

try:
    report = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    untrusted("the run wrote no report")
lines = open(sys.argv[2]).read().split()
if report.get("error") or not report.get("framesVisible"):
    untrusted(report.get("error") or "the frames were not visible")
cached = next((p for p in report["passes"] if p["name"] == "cached"), None)
if not cached or len(cached["frames"]) < 2 or len(lines) < 2:
    untrusted("no cached pass or no capture")
capture_start, capture_stop = float(lines[0]), float(lines[-1])
changed = [float(line) for line in lines[1:-1]]
frames = cached["frames"]
shown = [f["timestamp"] + (max(0, math.floor((f["committed"] - f["timestamp"]) / f["period"])) + 1) * f["period"]
         for f in frames]
period = statistics.median(f["period"] for f in frames)
# The first frame of a pass does not move the grid, so n frames are n - 1
# refreshes on which the picture should change. The window server shows a
# committed frame a refresh or two later, and the grid stands still before
# and after the pass, so the window is widened at its end only.
refreshes = round((shown[-1] - shown[0]) / period)
first, last = shown[0] + period / 2, shown[-1] + 3.5 * period
if not (capture_start < shown[0] - period and capture_stop > last):
    untrusted("the capture did not cover the whole cached pass")
on_screen = sum(1 for t in changed if first < t <= last)
if on_screen > refreshes:
    untrusted(f"the window changed on {on_screen} refreshes, more than the {refreshes} the scroll spans, so something else was animating")
print(f"cached pass, {refreshes} display refreshes at {1 / period:.0f} Hz")
print(f"  app's counter:   {cached['stats']['framesDropped']} dropped")
print(f"  screen capture:  the window's picture changed on {on_screen}, so {refreshes - on_screen} dropped")
PY
}

stage_seed

if [[ $MAC == 1 ]]; then
  if [[ $BUILD == 1 ]]; then build 'platform=macOS,arch=arm64' "$OUT/dd-mac"; package_mac; fi
  if [[ $MEASURE == 1 ]]; then
    [[ -d "$MAC_APP" ]] || blocker "no built Mac app at $MAC_APP; run without --skip-build first"
    mac_screen_unlocked || blocker "this Mac's screen is locked, so no frame is presented. Unlock it and run again."
    if [[ $SCREEN_CHECK == 1 ]]; then
      screen_check
      exit
    fi
    measure mac run_mac
  fi
fi

if [[ -n "$IPAD" ]]; then
  UDID="$(physical_device_id "$IPAD" || true)"
  [[ -n "$UDID" ]] || blocker "no paired physical device named '$IPAD' in: xcrun devicectl list devices"
  xcrun devicectl device info lockState --device "$UDID" > "$OUT/logs/ipad-lock.log" 2>&1 \
    || blocker "'$IPAD' is locked or unreachable. Unlock it, keep it awake on this network, and run again."
  if [[ $BUILD == 1 ]]; then
    build "platform=iOS,id=$UDID" "$OUT/dd-ipad" -allowProvisioningUpdates
    xcrun devicectl device install app --device "$UDID" \
      "$OUT/dd-ipad/Build/Products/Release-iphoneos/Maple.app" > "$OUT/logs/ipad-install.log" 2>&1 \
      || blocker "could not install on '$IPAD' (see $OUT/logs/ipad-install.log)"
  fi
  if [[ $MEASURE == 1 ]]; then
    for name in "${SEED_FILES[@]}"; do
      xcrun devicectl device copy to --device "$UDID" --domain-type appDataContainer \
        --domain-identifier "$IOS_BUNDLE_ID" --source "$SEED/$name" \
        --destination "$DEVICE_SEED/$name" >> "$OUT/logs/ipad-seed.log" 2>&1 \
        || blocker "could not copy the seed photos to '$IPAD' (see $OUT/logs/ipad-seed.log)"
    done
    measure ipad run_ipad "$UDID"
  fi
fi

if [[ -n "$SIMULATOR" ]]; then
  SIM_UDID="$(xcrun simctl list devices available \
    | awk -v name="$SIMULATOR (" 'index($0, name) { print }' | grep -oE '[0-9A-F-]{36}' | head -1 || true)"
  [[ -n "$SIM_UDID" ]] || blocker "no available simulator named '$SIMULATOR'"
  xcrun simctl bootstatus "$SIM_UDID" -b > "$OUT/logs/simulator-boot.log" 2>&1 \
    || blocker "the simulator did not boot (see $OUT/logs/simulator-boot.log)"
  if [[ $BUILD == 1 ]]; then
    build "platform=iOS Simulator,id=$SIM_UDID" "$OUT/dd-simulator"
    xcrun simctl install "$SIM_UDID" "$OUT/dd-simulator/Build/Products/Release-iphonesimulator/Maple.app" \
      || blocker "could not install on the simulator"
  fi
  if [[ $MEASURE == 1 ]]; then
    SIM_HOME="$(xcrun simctl get_app_container "$SIM_UDID" "$IOS_BUNDLE_ID" data 2>/dev/null || true)"
    [[ -n "$SIM_HOME" ]] || blocker "the app is not installed on the simulator; run without --skip-build first"
    rm -rf "${SIM_HOME:?}/$DEVICE_SEED"; mkdir -p "$SIM_HOME/$(dirname "$DEVICE_SEED")"
    cp -R "$SEED" "$SIM_HOME/$DEVICE_SEED"
    measure simulator run_simulator
  fi
fi

[[ $MEASURE == 1 ]] || exit 0

# shellcheck disable=SC2086
python3 - "$OUT" "$RUNS" "$COUNTS" $TARGETS <<'PY'
import json, os, statistics, sys

out, runs, counts, targets = sys.argv[1], int(sys.argv[2]), sys.argv[3].split(), sys.argv[4:]
cases = {"fresh": [("first", "cold"), ("cached", "warm")], "reopen": [("first", "reopened")]}
rows, untrusted = {}, []

def distrust(report, count, kind):
    if report.get("error"):
        return report["error"]
    if report.get("framesVisible") is not True:
        return "the frames were not visible (display asleep, screen locked or window hidden)"
    if report["photoCount"] != count:
        return "the report belongs to another run"
    if report["reusedFolder"] != (kind == "reopen"):
        return "the folder was not reused" if kind == "reopen" else "the folder was not rebuilt"
    if report["lowPowerMode"]:
        return "low-power mode was on"
    slowest = min(p["stats"]["refreshHz"] for p in report["passes"])
    if slowest < 0.95 * report["displayMaximumHz"]:
        return f"ran at {slowest:.0f} Hz on a {report['displayMaximumHz']} Hz display"
    return None

for target in targets:
    for count in counts:
        for kind, passes in cases.items():
            samples = []
            for run in range(1, runs + 1):
                name = f"{target}-{count}-{kind}-{run}.json"
                try:
                    report = json.load(open(os.path.join(out, "reports", name)))
                except (OSError, ValueError):
                    untrusted.append(f"{name}: no report")
                    continue
                reason = distrust(report, int(count), kind)
                if reason:
                    untrusted.append(f"{name}: {reason}")
                else:
                    samples.append(report)
            for pass_name, label in passes:
                rows[(target, int(count), label)] = [
                    (next(p["stats"] for p in r["passes"] if p["name"] == pass_name), r) for r in samples]

over = False
print(f"{'target':<10}{'photos':>7}  {'case':<9}{'runs':>5}  {'dropped min/med/max':>20}  {'longest stall ms':>17}  {'stall ms/s med':>15}  {'Hz':>4}  {'load':>11}  limit 0")
for (target, count, label), samples in sorted(rows.items()):
    if not samples:
        print(f"{target:<10}{count:>7}  {label:<9}{0:>5}  {'no trusted run':>20}")
        continue
    dropped = [s["framesDropped"] for s, _ in samples]
    stall = [s["longestStallMs"] for s, _ in samples]
    ratio = [s["stallMsPerSecond"] for s, _ in samples]
    loads = [r["loadAverageAtStart"] for _, r in samples]
    over = over or max(dropped) > 0
    figures = f"{min(dropped)} / {statistics.median(dropped):g} / {max(dropped)}"
    print(f"{target:<10}{count:>7}  {label:<9}{len(samples):>5}  {figures:>20}  {max(stall):>17.0f}  {statistics.median(ratio):>15.1f}  {samples[0][0]['refreshHz']:>4.0f}  {min(loads):>4.0f} - {max(loads):<4.0f}  {'met' if max(dropped) == 0 else 'NOT MET'}")

for line in untrusted:
    print("UNTRUSTED:", line)
sys.exit(2 if untrusted else 1 if over else 0)
PY
