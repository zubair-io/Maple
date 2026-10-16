#!/usr/bin/env bash
# Run inside android-emulator-runner, before its finally block kills the AVD.
set -euo pipefail
cd "$(dirname "$0")/.."
abi="${1:?Pass the emulator ABI}"
build_abis="${2:-$abi}"
artifacts="$PWD/ci-artifacts"
mkdir -p "$artifacts"
collect() {
	adb logcat -d -v threadtime >"$artifacts/logcat.txt" 2>&1 || true
	adb shell dumpsys activity >"$artifacts/activity.txt" 2>&1 || true
	adb shell dumpsys SurfaceFlinger >"$artifacts/surfaceflinger.txt" 2>&1 || true
	adb exec-out screencap -p >"$artifacts/screen.png" 2>/dev/null || true
	adb pull /sdcard/Download/MapleVerification "$artifacts/" || true
	adb pull /sdcard/Download/MapleWalkthrough "$artifacts/" || true
	adb pull /sdcard/Android/data/app.justmaple.aperture/files "$artifacts/app-files" || true
}
trap collect EXIT
adb logcat -c
# 1280x800 dp exercises the inspector/group reset and full sources column.
adb shell wm size 1280x800
adb shell wm density 160
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 0
adb shell input keyevent KEYCODE_WAKEUP
adb shell input keyevent KEYCODE_MENU
adb shell getprop >"$artifacts/device-properties.txt"
test "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" = 36
adb shell getprop ro.product.cpu.abilist | tr -d '\r' | tr ',' '\n' | grep -Fx "$abi"
adb shell am get-config | tee "$artifacts/configuration.txt" | grep -E 'sw[6-9][0-9]{2}dp.*w1[0-9]{3}dp'
adb shell pm list features | tee "$artifacts/features.txt" | grep -F android.hardware.vulkan.level
./gradlew --no-daemon "-PmapleAbis=$build_abis" connectedDebugAndroidTest
