#!/usr/bin/env bash
# Frame times while swiping a grid of photos: dumpsys gfxinfo before and after. For emulators only: it
# installs over the app and replaces its saved sources and cloud sign-ins for the run, then restores them
# (refuses a serial that is not emulator-<port> unless TIMING_ALLOW_DEVICE=1).
#   scripts/timing-scroll.sh <serial> <app.apk> <androidTest.apk> [photos] [swipes]
# The swipes start once the app has drawn and then stopped drawing for three seconds (at most 60 s). That
# shows rendering went quiet, not that every thumbnail is loaded; a folder that is still filling in
# will show up as extra janky frames.
set -euo pipefail
source "$(dirname "$0")/timing-lib.sh"
timing_attach "${1:?Pass the adb serial}"
apk="${2:?Pass the app APK}"
test_apk="${3:?Pass the androidTest APK}"
photos="${4:-2000}"
swipes="${5:-20}"
timing_require_count photos "$photos"
timing_require_count swipes "$swipes"
timing_install "$apk" "$test_apk"
timing_describe
trap timing_restore_sources EXIT
timing_instrument app.justmaple.aperture.LaunchSourcesSetup timingSources one-local timingPhotos "$photos"
device shell input keyevent KEYCODE_WAKEUP
device shell wm dismiss-keyguard
device shell am force-stop "$package"
device shell am start -W -n "$package/.MainActivity" >/dev/null
timing_wait_for_settled_frames 60
size="$(device shell wm size | tr -d '\r' | sed -n 's/.*: //p' | tail -n 1)"
width="${size%x*}"
height="${size#*x}"
device shell dumpsys gfxinfo "$package" reset >/dev/null
for ((swipe = 0; swipe < swipes; swipe++)); do
	device shell input swipe $((width / 2)) $((height * 3 / 4)) $((width / 2)) $((height / 4)) 250
	sleep 0.3
done
sleep 1
summary="$(device shell dumpsys gfxinfo "$package" | tr -d '\r' | awk -v photos="$photos" '
	/^Total frames rendered:/ { total = $4 }
	/^Janky frames:/ { janky = $3 " " $4 }
	/^50th percentile:/ { p50 = $3 }
	/^90th percentile:/ { p90 = $3 }
	/^95th percentile:/ { p95 = $3 }
	/^99th percentile:/ { p99 = $3 }
	END {
		if (total == "" || total == 0) exit 3
		printf "scroll.folder-%s frames=%s janky=%s p50=%s p90=%s p95=%s p99=%s\n", photos, total, janky, p50, p90, p95, p99
	}')" || {
	echo 'dumpsys gfxinfo reported no frames rendered; the swipes drew nothing, so there is no number' >&2
	exit 1
}
printf '%s\n' "$summary"
device shell am force-stop "$package"
