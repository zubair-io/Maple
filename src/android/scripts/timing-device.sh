#!/usr/bin/env bash
# One on-device timing benchmark per call; prints one line per number. For emulators only: it installs over
# the app, and the sources benchmark replaces the saved sources and cloud sign-ins and then restores them
# (refuses a serial that is not emulator-<port> unless TIMING_ALLOW_DEVICE=1).
#   scripts/timing-device.sh <serial> <app.apk> <androidTest.apk> <benchmark>
# benchmark: sources editor jni export cache decode folder grid cloud
# MAPLE_TIMING_RAW=<file> stages a RAW for editor, jni, export, decode and cloud (default: the committed
# 96 x 64 fixture); MAPLE_TIMING_ROUNDS sets the rounds (default 7).
set -euo pipefail
source "$(dirname "$0")/timing-lib.sh"
serial_argument="${1:?Pass the adb serial}"
apk="${2:?Pass the app APK}"
test_apk="${3:?Pass the androidTest APK}"
benchmark="${4:?Pass the benchmark: sources editor jni export cache decode folder grid cloud}"
case "$benchmark" in
sources) target=app.justmaple.aperture.SourcesTimingTest ;;
editor) target=app.justmaple.aperture.EditorTimingTest#openingThePhotoAndTickingASlider ;;
jni) target=app.justmaple.aperture.EditorTimingTest#crossingTheJniBoundary ;;
export) target=app.justmaple.aperture.ExportTimingTest ;;
cache) target=app.justmaple.aperture.ThumbnailCacheTimingTest#trimmingAThumbnailCacheAtAndUnderItsBudget ;;
decode) target=app.justmaple.aperture.ThumbnailCacheTimingTest#decodingA512PixelTileAtFullSizeAndHalfSize ;;
folder) target=app.justmaple.aperture.FolderListingTimingTest ;;
grid) target=app.justmaple.aperture.GridTimingTest ;;
cloud) target=app.justmaple.aperture.CloudThumbnailTimingTest ;;
*)
	echo "Unknown benchmark $benchmark" >&2
	exit 2
	;;
esac
timing_attach "$serial_argument"
timing_install "$apk" "$test_apk"
trap timing_restore_sources EXIT
timing_describe
if [[ -n "${MAPLE_TIMING_RAW:-}" ]]; then timing_stage_raw "$MAPLE_TIMING_RAW"; else timing_unstage_raw; fi
timing_instrument "$target"
