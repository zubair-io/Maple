#!/usr/bin/env bash
# Cold launch: `am start -W` after `am force-stop`, TotalTime and WaitTime per round. Both end at the first
# drawn frame, not when the photo grid has content. For emulators only: it installs over the app and replaces
# its saved sources and cloud sign-ins for the run, then restores them (refuses a serial that is not
# emulator-<port> unless TIMING_ALLOW_DEVICE=1).
#   scripts/timing-launch.sh <serial> <app.apk> <androidTest.apk> <zero|one-local|one-local-one-cloud> [rounds]
# one-local is a folder of 200 photos behind the debug document provider; the cloud source is a signed-in
# server record with no reachable server, so only the cost of reading it is measured. The first launch
# after install is discarded.
set -euo pipefail
source "$(dirname "$0")/timing-lib.sh"
timing_attach "${1:?Pass the adb serial}"
apk="${2:?Pass the app APK}"
test_apk="${3:?Pass the androidTest APK}"
sources="${4:?Pass the sources: zero one-local one-local-one-cloud}"
rounds="${5:-7}"
case "$sources" in
zero | one-local | one-local-one-cloud) ;;
*)
	echo "Unknown sources $sources" >&2
	exit 2
	;;
esac
timing_require_count rounds "$rounds"
timing_install "$apk" "$test_apk"
timing_describe
trap timing_restore_sources EXIT
timing_instrument app.justmaple.aperture.LaunchSourcesSetup timingSources "$sources" timingPhotos 200
device shell input keyevent KEYCODE_WAKEUP
device shell wm dismiss-keyguard
total=()
waiting=()
for ((round = 0; round < rounds + 1; round++)); do
	device shell am force-stop "$package"
	stop_deadline=$((SECONDS + 60))
	while [[ -n "$(device shell pidof "$package" | tr -d '\r')" ]]; do
		((SECONDS < stop_deadline)) || {
			echo "$package was still running 60 s after force-stop" >&2
			exit 1
		}
		sleep 0.2
	done
	sleep 2
	output="$(device shell am start -W -n "$package/.MainActivity" | tr -d '\r')"
	grep -q 'LaunchState: COLD' <<<"$output" || {
		echo "Launch was not cold: $output" >&2
		exit 1
	}
	if ((round > 0)); then
		total+=("$(sed -n 's/^TotalTime: //p' <<<"$output")")
		waiting+=("$(sed -n 's/^WaitTime: //p' <<<"$output")")
	fi
	timing_wait_for_settled_frames 60 || echo 'Continuing: the previous launch had not settled' >&2
done
summarise() {
	local name="$1"
	shift
	printf '%s\n' "$@" | sort -n | awk -v name="$name" -v rounds="$*" '{v[NR]=$1} END {
		median = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2
		printf "launch.%s unit=ms n=%d min=%s median=%s max=%s rounds=%s\n", name, NR, v[1], median, v[NR], rounds }'
}
summarise "$sources.time-to-first-draw.total-time" "${total[@]}"
summarise "$sources.time-to-first-draw.wait-time" "${waiting[@]}"
echo 'launch.note time to the first drawn frame (am start -W), not until the photo grid has content'
device shell am force-stop "$package"
