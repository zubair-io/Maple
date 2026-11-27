#!/usr/bin/env bash
# measure_slider_tick.sh — the editor's slider tick on the live GPU path,
# measured without UI automation (#6160).
#
# Usage:
#   src/scripts/measure_slider_tick.sh [--runs 5]
#
# For each fixture (the 100 MP reference RAW and one 24 MP-class RAW) it makes
# a throw-away copy, then runs the opt-in MapleCore test
# SliderTickPerformanceTests in a fresh `swift test -c release` process RUNS
# times. Each process opens the RAW through a real EditSession onto an
# offscreen CAMetalLayer and times 60 slider ticks per series (exposure,
# highlights, texture). A tick is one GpuLiveDriver.present call: it runs from
# entering the call to its return (the hop to the GPU session, parameters, drawable,
# encode and submit). It leaves out SwiftUI, the gesture, the scheduler's hops
# before the driver and GPU completion; backlog_ms in each line shows queued GPU
# work after the burst.
#
# It prints every run, then per fixture and series the minimum and median of
# the per-run medians and the median of the per-run p95, against the target
# of 16 ms and the hard limit of 50 ms. Exit status: 0 every median p95 is
# within the hard limit, 1 one is over it, 2 a step failed or a run printed no
# measurement, 64 bad arguments.
#
# RAW_DIR (default test-fixtures/raws, else the main checkout's) is only read.
# Everything the test writes goes to a folder made with mktemp, removed at exit.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PACKAGE="$REPO/src/apple/Packages/MapleCore"
TARGET_MS=16
HARD_LIMIT_MS=50
RUNS=5
FIXTURES=(dji-mavic3pro-100mp.dng test_0017.dng)

usage() {
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" >&2
	exit 64
}
fail() {
	echo "BLOCKED: $*" >&2
	exit 2
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--runs)
		[[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || usage
		RUNS="$2"
		shift
		;;
	*) usage ;;
	esac
	shift
done

if [[ -z "${RAW_DIR:-}" ]]; then
	RAW_DIR="$REPO/test-fixtures/raws"
	if [[ ! -d "$RAW_DIR" ]]; then
		COMMON_DIR="$(cd "$REPO" && git rev-parse --git-common-dir)"
		RAW_DIR="$(cd "$REPO" && cd "$COMMON_DIR/.." && pwd -P)/test-fixtures/raws"
	fi
fi
for name in "${FIXTURES[@]}"; do
	[[ -f "$RAW_DIR/$name" ]] || fail "RAW fixture missing: $RAW_DIR/$name"
done

WORK="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'fail "interrupted"' INT TERM

echo "load before: $(uptime | sed 's/.*load averages*: //')"

cd "$PACKAGE"
swift test -c release --filter SliderTickPerformanceTests >"$WORK/build.log" 2>&1 ||
	{
		cat "$WORK/build.log" >&2
		fail "the test target did not build"
	}

RESULTS="$WORK/results.txt"
: >"$RESULTS"
for name in "${FIXTURES[@]}"; do
	mkdir -p "$WORK/$name.d"
	copy="$WORK/$name.d/$name"
	cp -cL "$RAW_DIR/$name" "$copy" 2>/dev/null || cp -L "$RAW_DIR/$name" "$copy"
	for run in $(seq 1 "$RUNS"); do
		log="$WORK/$name.$run.log"
		MAPLE_PERF_SLIDER_RAW="$copy" swift test -c release --filter SliderTickPerformanceTests >"$log" 2>&1 ||
			{
				cat "$log" >&2
				fail "the measurement run failed for $name (run $run)"
			}
		grep -q '^SLIDER_TICK ' "$log" || {
			cat "$log" >&2
			fail "no measurement printed for $name (run $run); the test skipped or the GPU path is off"
		}
		while read -r line; do
			echo "$name run=$run ${line#SLIDER_TICK }"
			series="${line#*series=}"
			series="${series%% *}"
			median="${line#*median_ms=}"
			median="${median%% *}"
			p95="${line#*p95_ms=}"
			p95="${p95%% *}"
			min="${line#*min_ms=}"
			min="${min%% *}"
			echo "$name $series $min $median $p95" >>"$RESULTS"
		done < <(grep '^SLIDER_TICK ' "$log")
	done
done

echo "load after: $(uptime | sed 's/.*load averages*: //')"
echo
echo "target ${TARGET_MS} ms, hard limit ${HARD_LIMIT_MS} ms; ${RUNS} process runs per fixture"
sort -k1,1 -k2,2 "$RESULTS" | awk -v target="$TARGET_MS" -v limit="$HARD_LIMIT_MS" '
function median(values, n,    sorted, i, j, tmp) {
	for (i = 1; i <= n; i++) sorted[i] = values[i]
	for (i = 2; i <= n; i++) {
		tmp = sorted[i]
		for (j = i - 1; j >= 1 && sorted[j] > tmp; j--) sorted[j + 1] = sorted[j]
		sorted[j + 1] = tmp
	}
	return (sorted[int((n + 1) / 2)] + sorted[int((n + 2) / 2)]) / 2
}
function flush(    status, minOfMedians) {
	if (count == 0) return
	minOfMedians = medians[1]
	for (i = 2; i <= count; i++) if (medians[i] < minOfMedians) minOfMedians = medians[i]
	medianP95 = median(p95s, count)
	status = medianP95 > limit ? "OVER HARD LIMIT" : (medianP95 > target ? "over target" : "within target")
	if (medianP95 > limit) over = 1
	printf "%s series=%s min_of_medians_ms=%.2f median_of_medians_ms=%.2f median_p95_ms=%.2f  %s\n", fixture, series, minOfMedians, median(medians, count), medianP95, status
	count = 0
}
{
	if ($1 != fixture || $2 != series) flush()
	fixture = $1; series = $2
	count++; medians[count] = $4; p95s[count] = $5
}
END {
	flush()
	exit over
}
'
