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
configure_display() {
	adb shell wm size 1280x800
	adb shell wm density 160
	adb shell settings put system accelerometer_rotation 0
	adb shell settings put system user_rotation 0
	adb shell input keyevent KEYCODE_WAKEUP
}
configure_display
adb shell getprop >"$artifacts/device-properties.txt"
test "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" = 36
adb shell getprop ro.product.cpu.abilist | tr -d '\r' | tr ',' '\n' | grep -Fx "$abi"
adb shell am get-config | tee "$artifacts/configuration.txt" | grep -E 'sw[6-9][0-9]{2}dp.*w1[0-9]{3}dp'
adb shell pm list features | tee "$artifacts/features.txt" | grep -F android.hardware.vulkan.level

# A cold API 36 boot can leave an ANR dialog over DocumentsUI. In #4878 the
# SystemUI KeyguardService ANR began before instrumentation and stayed focused
# through all three real folder-picker tests. Qualify the device before tests.
boot_ui_health() {
	local focus services busy sample ready=0
	for ((sample = 0; sample < 45; sample++)); do
		focus="$(adb shell dumpsys window | awk '/mCurrentFocus=/{print; exit}')"
		printf '%s\n' "$focus" >>"$artifacts/boot-ui-focus.txt"
		if [[ "$focus" == *'Application Not Responding:'* ]]; then
			return 2
		fi
		services="$(adb shell dumpsys activity services)"
		busy="$(printf '%s\n' "$services" | awk '
			/ServiceRecord\{.*com.android.systemui\/.keyguard.KeyguardService/ { keyguard = 1 }
			keyguard && /executeNesting=[1-9]/ { print; exit }
			keyguard && /^  \* ServiceRecord/ { keyguard = 0 }
		')"
		if [[ "$focus" == *'com.google.android.apps.nexuslauncher/'*'NexusLauncherActivity'* ]] &&
			[[ -z "$busy" ]] && [[ -n "$(adb shell pidof com.android.systemui)" ]]; then
			((ready += 1))
			if ((ready == 5)); then return 0; fi
		else
			ready=0
		fi
		sleep 1
	done
	return 1
}

if boot_ui_health; then
	echo 'Android boot UI healthy before instrumentation'
else
	status=$?
	adb shell dumpsys window >"$artifacts/boot-ui-window.txt" || true
	adb shell dumpsys activity >"$artifacts/boot-ui-activity.txt" || true
	adb logcat -d -v threadtime >"$artifacts/boot-ui-logcat.txt" || true
	if ((status != 2)); then
		echo 'Android boot UI did not become healthy; refusing to run instrumentation' >&2
		exit 1
	fi
	# Recover only the observed pre-test ANR, once. A second unhealthy boot fails.
	echo 'Android boot ANR observed; rebooting emulator once before instrumentation'
	adb reboot
	timeout 180 adb wait-for-device
	booted=false
	for ((sample = 0; sample < 90; sample++)); do
		if [[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; then
			booted=true
			break
		fi
		sleep 2
	done
	if [[ "$booted" != true ]]; then
		echo 'Android did not complete recovery boot' >&2
		exit 1
	fi
	configure_display
	adb shell input keyevent KEYCODE_MENU
	if ! boot_ui_health; then
		echo 'Android boot UI remained unhealthy after one recovery boot' >&2
		exit 1
	fi
	echo 'Android boot UI healthy after one recovery boot'
fi
./gradlew --no-daemon "-PmapleAbis=$build_abis" connectedDebugAndroidTest
