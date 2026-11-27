#!/usr/bin/env bash
# Boots a headless emulator on a fixed port, or stops the one this script started (by PID). The timing
# scripts are for emulators only; this is the way to get one.
#   scripts/timing-emulator.sh start <avd-name> <port>   prints the serial (emulator-<port>)
#   scripts/timing-emulator.sh stop <port>
# Create the AVD first, for example:
#   avdmanager create avd -n MaplePerfW2 -d pixel_7 -k "system-images;android-36;google_apis;arm64-v8a"
# MAPLE_TIMING_GPU selects the emulator's -gpu mode (default host). The SDK is ANDROID_HOME, else
# ANDROID_SDK_ROOT, else the platform's default location.
set -euo pipefail
case "$(uname -s)" in
Darwin) default_sdk="$HOME/Library/Android/sdk" ;;
*) default_sdk="$HOME/Android/Sdk" ;;
esac
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$default_sdk}}"
emulator_binary="$sdk/emulator/emulator"
PATH="$sdk/platform-tools:$PATH"
state="${TMPDIR:-/tmp}/maple-timing-emulator"
mkdir -p "$state"
command="${1:?Pass start or stop}"

is_emulator_process() {
	local name
	name="$(ps -p "$1" -o comm= 2>/dev/null)" || return 1
	name="$(basename "${name// /}")"
	[[ "$name" == emulator* || "$name" == qemu-system* ]]
}

stop_recorded_emulator() {
	local port="$1" pid_file="$state/$1.pid" pid
	pid="$(<"$pid_file")"
	if is_emulator_process "$pid"; then
		kill "$pid"
	else
		echo "Pid $pid from $pid_file is not an emulator process; not killing it" >&2
	fi
	rm -f "${pid_file:?}"
}

case "$command" in
start)
	avd="${2:?Pass the AVD name}"
	port="${3:?Pass an even console port that is not 5554}"
	serial="emulator-$port"
	[[ -x "$emulator_binary" ]] || {
		echo "No emulator at $emulator_binary; set ANDROID_HOME to the SDK" >&2
		exit 1
	}
	command -v adb >/dev/null || {
		echo "adb not found in $sdk/platform-tools or on PATH; set ANDROID_HOME to the SDK" >&2
		exit 1
	}
	if [[ -f "$state/$port.pid" ]] && is_emulator_process "$(<"$state/$port.pid")"; then
		echo "An emulator started by this script already runs on port $port" >&2
		exit 1
	fi
	"$emulator_binary" -avd "$avd" -port "$port" -no-window -no-snapshot -noaudio -no-boot-anim \
		-gpu "${MAPLE_TIMING_GPU:-host}" >"$state/$port.log" 2>&1 &
	echo $! >"$state/$port.pid"
	booted=0
	for ((attempt = 0; attempt < 240; attempt++)); do
		if [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
			booted=1
			break
		fi
		is_emulator_process "$(<"$state/$port.pid")" || {
			cat "$state/$port.log" >&2
			echo 'The emulator exited during boot' >&2
			rm -f "${state:?}/${port:?}.pid"
			exit 1
		}
		sleep 2
	done
	if ((booted == 0)); then
		echo "$serial did not finish booting within 480 s; stopping it. Log: $state/$port.log" >&2
		stop_recorded_emulator "$port"
		exit 1
	fi
	adb -s "$serial" shell settings put global window_animation_scale 0
	adb -s "$serial" shell settings put global transition_animation_scale 0
	adb -s "$serial" shell settings put global animator_duration_scale 0
	adb -s "$serial" shell settings put global stay_on_while_plugged_in 7
	echo "$serial pid=$(<"$state/$port.pid") log=$state/$port.log"
	;;
stop)
	port="${2:?Pass the console port}"
	[[ -f "$state/$port.pid" ]] || {
		echo "No emulator was started by this script on port $port" >&2
		exit 1
	}
	pid="$(<"$state/$port.pid")"
	if ! is_emulator_process "$pid"; then
		echo "Pid $pid from $state/$port.pid is not an emulator process; not killing it" >&2
		rm -f "${state:?}/${port:?}.pid"
		exit 1
	fi
	adb -s "emulator-$port" emu kill >/dev/null 2>&1 || true
	for ((attempt = 0; attempt < 30; attempt++)); do
		is_emulator_process "$pid" || break
		sleep 1
	done
	if is_emulator_process "$pid"; then kill "$pid"; fi
	rm -f "${state:?}/${port:?}.pid"
	echo "stopped emulator on port $port (pid $pid)"
	;;
*)
	echo "Unknown command $command" >&2
	exit 2
	;;
esac
