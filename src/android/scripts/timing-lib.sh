#!/usr/bin/env bash
# Sourced by the timing-*.sh scripts. These scripts are for emulators only: they install over the app,
# replace its saved sources and clear its caches, so they refuse a serial that is not emulator-<port> unless
# TIMING_ALLOW_DEVICE=1 is set. Every adb call names its device by serial, so a script never touches another
# emulator or phone that happens to be attached.
set -euo pipefail
package=app.justmaple.aperture
runner="$package.test/androidx.test.runner.AndroidJUnitRunner"
benchmark_annotation="$package.TimingBenchmark"
serial=''
[[ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]] || PATH="${ANDROID_HOME:-$ANDROID_SDK_ROOT}/platform-tools:$PATH"

timing_attach() {
	command -v adb >/dev/null || {
		echo 'adb not found: put it on PATH or set ANDROID_HOME to the SDK' >&2
		return 1
	}
	serial="${1:?Pass the adb serial, for example emulator-5580}"
	[[ "$serial" == emulator-* || "${TIMING_ALLOW_DEVICE:-}" == 1 ]] || {
		echo "Refusing $serial: these scripts are for emulators and replace the app's saved sources." >&2
		echo 'Set TIMING_ALLOW_DEVICE=1 to run on a device you can afford to reset.' >&2
		return 1
	}
	[[ "$(adb -s "$serial" get-state 2>/dev/null)" == device ]] || {
		echo "No device with serial $serial" >&2
		return 1
	}
	[[ "${TIMING_ALLOW_DEVICE:-}" == 1 ]] || {
		local qemu
		qemu="$(adb -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')"
		[[ "$qemu" == 1 ]] || qemu="$(adb -s "$serial" shell getprop ro.boot.qemu | tr -d '\r')"
		[[ "$qemu" == 1 ]] || {
			echo "Refusing $serial: it does not report running under an emulator (ro.kernel.qemu, ro.boot.qemu)." >&2
			return 1
		}
	}
}

device() { adb -s "$serial" "$@"; }

timing_install() {
	local apk="${1:?Pass the app APK}" test_apk="${2:?Pass the androidTest APK}"
	device install -r -t -g "$apk" >/dev/null
	device install -r -t "$test_apk" >/dev/null
}

timing_describe() {
	printf 'device serial=%s sdk=%s model=%s abi=%s\n' "$serial" \
		"$(device shell getprop ro.build.version.sdk | tr -d '\r')" \
		"$(device shell getprop ro.product.model | tr -d '\r')" \
		"$(device shell getprop ro.product.cpu.abi | tr -d '\r')"
}

# Copies a RAW into the app's private files, where the benchmarks look for it. The staged name is fixed, so
# nothing from the host file name reaches the device shell; only the extension is kept, as the app reads it.
timing_stage_raw() {
	local raw="${1:?Pass a RAW file}" extension name
	extension="${raw##*.}"
	[[ "$raw" == *.* && "$extension" =~ ^[A-Za-z0-9]{1,8}$ ]] || {
		echo "$raw needs a plain file extension such as .dng" >&2
		return 1
	}
	name="source.$extension"
	device shell "run-as $package sh -c 'rm -rf files/maple-timing/raw && mkdir -p files/maple-timing/raw'"
	device shell "run-as $package sh -c 'cat > files/maple-timing/raw/$name'" <"$raw"
	local staged
	staged="$(device shell run-as "$package" wc -c "files/maple-timing/raw/$name" | awk '{print $1}')"
	[[ "$staged" == "$(wc -c <"$raw" | tr -d ' ')" ]] || {
		echo "Staging $raw failed: $staged bytes on the device" >&2
		return 1
	}
}

timing_unstage_raw() { device shell "run-as $package sh -c 'rm -rf files/maple-timing/raw'"; }

# timing_instrument <class[#method]> [name value]...: prints one line per number, fails on a failed test.
timing_instrument() {
	local target="$1"
	shift
	local arguments=(-e annotation "$benchmark_annotation" -e class "$target")
	if [[ -n "${MAPLE_TIMING_ROUNDS:-}" ]]; then
		timing_require_count MAPLE_TIMING_ROUNDS "$MAPLE_TIMING_ROUNDS" 1
		arguments+=(-e timingRounds "$MAPLE_TIMING_ROUNDS")
	fi
	if [[ -n "${MAPLE_TIMING_TICKS:-}" ]]; then
		timing_require_count MAPLE_TIMING_TICKS "$MAPLE_TIMING_TICKS" 2
		arguments+=(-e timingTicks "$MAPLE_TIMING_TICKS")
	fi
	while (($# >= 2)); do
		arguments+=(-e "$1" "$2")
		shift 2
	done
	local timeout="${MAPLE_TIMING_TIMEOUT:-1200}" output_file output status=0 pid deadline
	timing_require_count MAPLE_TIMING_TIMEOUT "$timeout" 1
	output_file="$(mktemp "${TMPDIR:-/tmp}/maple-timing.XXXXXX")"
	device shell am instrument -w -r "${arguments[@]}" "$runner" >"$output_file" 2>&1 &
	pid=$!
	deadline=$((SECONDS + timeout))
	while kill -0 "$pid" 2>/dev/null; do
		if ((SECONDS >= deadline)); then
			kill "$pid" 2>/dev/null || true
			device shell am force-stop "$package" || true
			rm -f "$output_file"
			echo "Benchmark $target timed out after ${timeout}s" >&2
			return 1
		fi
		sleep 0.5
	done
	wait "$pid" || status=$?
	output="$(tr -d '\r' <"$output_file")"
	rm -f "$output_file"
	printf '%s\n' "$output" | sed -n 's/^INSTRUMENTATION_STATUS: maple_timing=//p'
	if ((status != 0)) || ! printf '%s\n' "$output" | grep -q '^OK ([1-9]'; then
		printf '%s\n' "$output" | grep -E 'stack=|Error|Exception|shortMsg|FAILURES|Tests run' >&2 || true
		echo "Benchmark $target failed" >&2
		return 1
	fi
}

# timing_require_count <name> <value> [minimum, default 1]: a whole number of at least the minimum.
timing_require_count() {
	local minimum="${3:-1}"
	if [[ "$2" =~ ^[0-9]{1,9}$ ]] && ((10#$2 >= minimum)); then return 0; fi
	echo "$1 must be a whole number of at least $minimum, got '$2'" >&2
	return 1
}

# timing_restore_sources: puts back the sources and cloud sign-ins timing_instrument LaunchSourcesSetup replaced.
timing_restore_sources() {
	device shell am force-stop "$package" || true
	timing_instrument app.justmaple.aperture.LaunchSourcesRestore >/dev/null ||
		echo "Could not restore the app's saved sources; reinstall the app or add them again" >&2
}

timing_frames() {
	local report
	report="$(device shell dumpsys gfxinfo "$package" | tr -d '\r')" || report=''
	sed -n '/^Total frames rendered: /{s///;p;q;}' <<<"$report"
}

# timing_wait_for_settled_frames <timeout seconds>: succeeds once the app has drawn and then drawn nothing new
# for three consecutive seconds. This sees that rendering went quiet, not that a particular grid is loaded.
timing_wait_for_settled_frames() {
	local timeout="$1" last='' still=0 frames
	for ((second = 0; second < timeout; second++)); do
		frames="$(timing_frames)"
		if [[ -n "$frames" && "$frames" != 0 && "$frames" == "$last" ]]; then still=$((still + 1)); else still=0; fi
		((still < 3)) || return 0
		last="$frames"
		sleep 1
	done
	echo "The app was still drawing after ${timeout}s" >&2
	return 1
}
