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
#     folder), and a running copy is terminated. The seed photos and the
#     reports stay in that app's Library/Caches and the cloned folders in its
#     tmp; the system reclaims both when it needs the space.
#   * Like every build of the app, the build removes *.xmp sidecars and .maple
#     folders under this checkout's test-fixtures/raws.
#
# --screen-check cross-checks the app's counter instead of measuring: one
# 500-photo Mac launch is recorded by the system's screen-capture stream
# (grid_scroll_screen_capture.swift, needs Screen Recording permission), and
# for each pass the refreshes on which the grid actually moved on screen are
# printed next to the app's count. A picture that changed without the grid
# moving (a thumbnail arriving) does not count as a scroll step.
#
# --build-only / --skip-build split the build from the timing so each can run
# in its own slot on a busy machine.

# The run_* and *_pid functions are passed by name.
# shellcheck disable=SC2329
set -eEuo pipefail

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

APP_PID=""
CAPTURE_PID=""
stop_children() {
  [[ -z "$APP_PID" ]] || kill "$APP_PID" 2>/dev/null || true
  [[ -z "$CAPTURE_PID" ]] || kill "$CAPTURE_PID" 2>/dev/null || true
}
usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" >&2; exit 64; }
blocker() { echo "BLOCKED: $*" >&2; stop_children; exit 2; }
trap 'blocker "a step failed at line $LINENO"' ERR
trap 'blocker "interrupted"' INT TERM
positive_integers() {
  local value
  [[ $# -gt 0 ]] || return 1
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
positive_integers $COUNTS || usage
positive_integers "$RUNS" || usage
[[ $BUILD == 1 || $MEASURE == 1 ]] || usage
[[ $SCREEN_CHECK == 0 || ( -z "$IPAD" && -z "$SIMULATOR" ) ]] || usage
[[ $MAC == 0 && -z "$IPAD" && -z "$SIMULATOR" ]] && MAC=1

# Everything below removes and rebuilds folders inside OUT, so OUT must be
# new, empty, or one an earlier run of this script marked as its own.
if [[ -d "$OUT" && ! -f "$OUT/.maple-grid-scroll" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  blocker "$OUT exists and is not a folder this script made; choose another --out (or, if it is this script's from an older version: touch '$OUT/.maple-grid-scroll')"
fi
mkdir -p "$OUT/reports" "$OUT/logs"
touch "$OUT/.maple-grid-scroll"
OUT="$(cd "$OUT" && pwd -P)"
[[ -d "$RAW_DIR" ]] || blocker "no RAW fixtures at $RAW_DIR (set RAW_DIR)"
RAW_DIR="$(cd "$RAW_DIR" && pwd -P)"
case "$RAW_DIR/" in "$OUT"/*) blocker "RAW_DIR must not be inside the output folder $OUT" ;; esac
SEED="$OUT/seed"
MAC_APP="$OUT/mac/Maple.app"
PROJECT="$REPO/src/apple/Maple.xcodeproj"
TARGETS=""
RUN_ID="$(date +%s)-$$"

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
  local binary
  for binary in "$derived"/Build/Products/Release*/Maple.app/Maple \
    "$derived"/Build/Products/Release*/Maple.app/Contents/MacOS/Maple; do
    [[ -f "$binary" ]] || continue
    if (nm "$binary" 2>/dev/null || true) | grep -q '___llvm_profile_runtime'; then
      blocker "the built app carries coverage instrumentation, so its timings would not be the shipped app's"
    fi
  done
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
  ps -axo pid=,comm= | awk -v binary="$MAC_APP/Contents/MacOS/Maple" \
    '{ pid = $1; sub(/^ *[0-9]+ /, ""); if ($0 == binary) { print pid; exit } }'
}

# Waits for `waiter` to exit. A launch that is still running after
# LAUNCH_TIMEOUT seconds would be repeated by every remaining case, so the
# app whose process id `find_pid` prints is stopped and the whole run ends.
wait_or_stop() {
  local waiter="$1" find_pid="$2" waited=0
  while kill -0 "$waiter" 2>/dev/null && (( waited < LAUNCH_TIMEOUT )); do
    sleep 1; waited=$((waited + 1))
    [[ -n "$APP_PID" ]] || APP_PID="$($find_pid || true)"
  done
  if kill -0 "$waiter" 2>/dev/null; then
    kill "$waiter" 2>/dev/null || true
    blocker "a launch did not finish within $LAUNCH_TIMEOUT seconds"
  fi
  wait "$waiter" 2>/dev/null || true
  APP_PID=""
}

run_mac() {
  local count="$1" kind="$2" run="$3" report="$4" reuse=0
  [[ $kind == reopen ]] && reuse=1
  rm -f "$report"
  # Saved window state is ignored: after a run that quit mid-scroll the system
  # can restore "no windows", and an app with no window never starts the run.
  open -n -W -a "$MAC_APP" --env "MAPLE_SCROLL_RUN_SEED=$SEED" \
    --env "MAPLE_SCROLL_RUN_COUNT=$count" --env "MAPLE_SCROLL_RUN_REPORT=$report" \
    --env "MAPLE_SCROLL_RUN_REUSE=$reuse" --args -ApplePersistenceIgnoreState YES &
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
  local remote="Library/Caches/maple-scroll-run-$RUN_ID-$count-$kind-$run.json"
  [[ $kind == reopen ]] && reuse=1
  rm -f "$report"
  xcrun devicectl device process launch --device "$udid" --console --terminate-existing \
    --timeout "$LAUNCH_TIMEOUT" --environment-variables \
    "{\"MAPLE_SCROLL_RUN_SEED\":\"$DEVICE_SEED\",\"MAPLE_SCROLL_RUN_COUNT\":\"$count\",\"MAPLE_SCROLL_RUN_REPORT\":\"$remote\",\"MAPLE_SCROLL_RUN_REUSE\":\"$reuse\"}" \
    "$IOS_BUNDLE_ID" >> "$OUT/logs/ipad-launch.log" 2>&1 || true
  xcrun devicectl device copy from --device "$udid" --domain-type appDataContainer \
    --domain-identifier "$IOS_BUNDLE_ID" --source "$remote" --destination "$report" \
    >> "$OUT/logs/ipad-launch.log" 2>&1 || true
  # A launch with no report is one failed run, unless the device has locked,
  # in which case every remaining launch would wait out its timeout.
  [[ -f "$report" ]] || ipad_unlocked \
    || blocker "'$IPAD' locked or went out of reach during the run. Unlock it and run again with --skip-build."
}

simulator_app_pid() {
  xcrun simctl spawn "$SIM_UDID" launchctl list 2>/dev/null \
    | awk -v id="UIKitApplication:$IOS_BUNDLE_ID" 'index($3, id) == 1 && $1 != "-" { print $1; exit }'
}

run_simulator() {
  local count="$1" kind="$2" run="$3" report="$4" reuse=0
  local remote="Library/Caches/maple-scroll-run-$RUN_ID-$count-$kind-$run.json"
  [[ $kind == reopen ]] && reuse=1
  rm -f "$report"
  SIMCTL_CHILD_MAPLE_SCROLL_RUN_SEED="$DEVICE_SEED" SIMCTL_CHILD_MAPLE_SCROLL_RUN_COUNT="$count" \
    SIMCTL_CHILD_MAPLE_SCROLL_RUN_REPORT="$remote" SIMCTL_CHILD_MAPLE_SCROLL_RUN_REUSE="$reuse" \
    xcrun simctl launch --console --terminate-running-process "$SIM_UDID" "$IOS_BUNDLE_ID" \
    >> "$OUT/logs/simulator-launch.log" 2>&1 &
  wait_or_stop $! simulator_app_pid
  cp "$SIM_HOME/$remote" "$report" 2>/dev/null || true
}

# `measure <target> <built app's Info.plist> <runner...>`. The plist's build
# stamp is what every report must carry, so a report from another build of
# the app (an older install, another checkout's copy) is refused.
measure() {
  local target="$1" plist="$2" count run kind
  shift 2
  TARGETS="$TARGETS $target"
  rm -f "$OUT"/reports/"$target"-*.json
  /usr/libexec/PlistBuddy -c "Print :MapleBuildGitSHA" "$plist" > "$OUT/reports/$target.build" 2>/dev/null \
    || blocker "no built app for $target; run without --skip-build first"
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
  CAPTURE_PID=$capture
  run_mac 500 fresh 1 "$report"
  wait $capture || blocker "screen capture failed: $(tail -1 "$OUT/logs/screen-capture.log")"
  CAPTURE_PID=""
  local status=0
  python3 - "$report" "$frames" <<'PY' || status=$?
import json, math, statistics, sys

def untrusted(reason):
    print("UNTRUSTED:", reason)
    sys.exit(2)

try:
    report = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    untrusted("the run wrote no report")
if report.get("error") or not report.get("framesVisible"):
    untrusted(report.get("error") or "the frames were not visible")
lines = open(sys.argv[2]).read().splitlines()
if len(lines) < 4 or not lines[0].startswith("start ") or not lines[-1].startswith("stop "):
    untrusted("the capture recorded nothing")
capture_start, capture_stop = float(lines[0].split()[1]), float(lines[-1].split()[1])
samples = [(float(time), [int(v) for v in profile.split(",")])
           for time, profile in (line.split(" ", 1) for line in lines[1:-1])]

# Rows that never change during the passes are the letterbox around the
# window and its toolbar; the grid is the band of rows that does.
begun = min(scroll["frames"][0]["timestamp"] for scroll in report["passes"])
during = [profile for time, profile in samples if time >= begun]
if len(during) < 2:
    untrusted("the capture recorded nothing during the passes")
height = len(during[0])
spread = [max(p[row] for p in during) - min(p[row] for p in during) for row in range(height)]
live = [row for row in range(height) if spread[row] > max(spread) * 0.05]
if not live or live[-1] - live[0] < 200:
    untrusted("the captured window is too small to follow the grid")
top, bottom = live[0] + 30, live[-1] - 5

def centred(profile):
    band = profile[top:bottom]
    mean = sum(band) / len(band)
    return [v - mean for v in band]

def moved(before, after):
    """True when `after` is `before` scrolled up: some shift matches better than none."""
    def match(shift):
        a, b = before[shift:], after[:len(after) - shift]
        norm = math.sqrt(sum(v * v for v in a) * sum(v * v for v in b))
        return sum(x * y for x, y in zip(a, b)) / norm if norm else 0
    best = max(range(0, min(120, len(before) - 80)), key=match)
    return best > 2

profiles = [(time, centred(profile)) for time, profile in samples]
worst = 0
for scroll in report["passes"]:
    frames = scroll["frames"]
    period = statistics.median(f["period"] for f in frames)
    # The first frame of a pass does not move the grid, so n frames span
    # n - 1 refreshes on which it should move. The window server shows a
    # committed frame a few refreshes after its display-link timestamp.
    refreshes = round((frames[-1]["timestamp"] - frames[0]["timestamp"]) / period)
    first, last = frames[0]["timestamp"], frames[-1]["timestamp"] + 4 * period
    if capture_start > first or capture_stop < frames[-1]["timestamp"]:
        if scroll["name"] == "cached":
            untrusted("the capture did not cover the cached pass")
        print(f"{scroll['name']} pass: not compared, the capture started after it began")
        continue
    inside = [i for i, (time, _) in enumerate(profiles) if first <= time <= last and i > 0]
    steps = sum(1 for i in inside if moved(profiles[i - 1][1], profiles[i][1]))
    app = scroll["stats"]["framesDropped"]
    print(f"{scroll['name']} pass, {refreshes} display refreshes at {1 / period:.0f} Hz")
    print(f"  app's counter:   {app} dropped")
    print(f"  screen capture:  the grid moved on {steps}, so {refreshes - steps} dropped")
    worst = max(worst, abs(refreshes - steps - app))
print(f"largest disagreement: {worst} frames")
PY
  return $status
}

ipad_unlocked() {
  xcrun devicectl device info lockState --device "$UDID" > "$OUT/logs/ipad-lock.log" 2>&1
}

# Every target is resolved before the first build, so a missing device does
# not surface after another target's twenty-minute measurement.
UDID=""
SIM_UDID=""
if [[ -n "$IPAD" ]]; then
  UDID="$(physical_device_id "$IPAD" || true)"
  [[ -n "$UDID" ]] || blocker "no paired physical device named '$IPAD' in: xcrun devicectl list devices"
  ipad_unlocked || blocker "'$IPAD' is locked or unreachable. Unlock it, keep it awake on this network, and run again."
fi
if [[ -n "$SIMULATOR" ]]; then
  SIM_UDID="$(xcrun simctl list devices available \
    | awk -v name="    $SIMULATOR (" 'index($0, name) == 1 { print }' | grep -oE '[0-9A-F-]{36}' | head -1 || true)"
  [[ -n "$SIM_UDID" ]] || blocker "no available simulator named '$SIMULATOR'"
fi

stage_seed

if [[ $MAC == 1 ]]; then
  if [[ $BUILD == 1 ]]; then build 'platform=macOS,arch=arm64' "$OUT/dd-mac"; package_mac; fi
  if [[ $MEASURE == 1 ]]; then
    [[ -d "$MAC_APP" ]] || blocker "no built Mac app at $MAC_APP; run without --skip-build first"
    mac_screen_unlocked || blocker "this Mac's screen is locked, so no frame is presented. Unlock it and run again."
    if [[ $SCREEN_CHECK == 1 ]]; then
      screen_check || exit $?
      exit 0
    fi
    measure mac "$MAC_APP/Contents/Info.plist" run_mac
  fi
fi

if [[ -n "$IPAD" ]]; then
  if [[ $BUILD == 1 ]]; then
    build "platform=iOS,id=$UDID" "$OUT/dd-ipad" -allowProvisioningUpdates
    xcrun devicectl device install app --device "$UDID" \
      "$OUT/dd-ipad/Build/Products/Release-iphoneos/Maple.app" > "$OUT/logs/ipad-install.log" 2>&1 \
      || blocker "could not install on '$IPAD' (see $OUT/logs/ipad-install.log)"
  fi
  if [[ $MEASURE == 1 ]]; then
    ipad_unlocked || blocker "'$IPAD' has locked. Unlock it and run again with --skip-build."
    for name in "${SEED_FILES[@]}"; do
      xcrun devicectl device copy to --device "$UDID" --domain-type appDataContainer \
        --domain-identifier "$IOS_BUNDLE_ID" --source "$SEED/$name" \
        --destination "$DEVICE_SEED/$name" >> "$OUT/logs/ipad-seed.log" 2>&1 \
        || blocker "could not copy the seed photos to '$IPAD' (see $OUT/logs/ipad-seed.log)"
    done
    measure ipad "$OUT/dd-ipad/Build/Products/Release-iphoneos/Maple.app/Info.plist" run_ipad "$UDID"
  fi
fi

if [[ -n "$SIMULATOR" ]]; then
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
    measure simulator "$OUT/dd-simulator/Build/Products/Release-iphonesimulator/Maple.app/Info.plist" \
      run_simulator
  fi
fi

[[ $MEASURE == 1 ]] || exit 0

status=0
# shellcheck disable=SC2086
python3 - "$OUT" "$RUNS" "$COUNTS" $TARGETS <<'PY' || status=$?
import json, os, statistics, sys

out, runs, counts, targets = sys.argv[1], int(sys.argv[2]), sys.argv[3].split(), sys.argv[4:]
cases = {"fresh": [("first", "cold"), ("cached", "warm")], "reopen": [("first", "reopened")]}
rows, untrusted = {}, []

def distrust(report, count, kind, build):
    if report.get("error"):
        return report["error"]
    if report.get("framesVisible") is not True:
        return "the frames were not visible (display asleep, screen locked or window hidden)"
    if report["photoCount"] != count:
        return "the report belongs to another run"
    if report["reusedFolder"] != (kind == "reopen"):
        return "the folder was not reused" if kind == "reopen" else "the folder was not rebuilt"
    if report["build"] != f"{build} Release":
        return f"measured build '{report['build']}', not the Release build {build} this script made"
    if report["lowPowerMode"]:
        return "low-power mode was on"
    if report["thermalState"] in ("serious", "critical"):
        return f"the device was throttling (thermal state {report['thermalState']})"
    slowest = min(p["stats"]["refreshHz"] for p in report["passes"])
    if not report["displayMaximumHz"] or slowest < 0.95 * report["displayMaximumHz"]:
        return f"ran at {slowest:.0f} Hz on a {report['displayMaximumHz']} Hz display"
    if kind == "fresh" and report["cachedThumbnails"] < count:
        return f"only {report['cachedThumbnails']} of {count} thumbnails were cached before the warm pass"
    return None

for target in targets:
    build = open(os.path.join(out, "reports", f"{target}.build")).read().strip()
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
                reason = distrust(report, int(count), kind, build)
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
exit $status
