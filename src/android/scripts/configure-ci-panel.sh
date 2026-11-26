#!/usr/bin/env bash
# #4984: a runtime wm override on the 2560x1600 panel made SurfaceFlinger scale every frame and starved first-boot SystemUI.
set -euo pipefail
config="${ANDROID_AVD_HOME:-$HOME/.android/avd}/${1:?Pass the AVD name}.avd/config.ini"
if [[ ! -w "$config" ]]; then
	echo "AVD config is missing or read-only: $config" >&2
	exit 1
fi
# BSD sed reads the argument after a bare -i as the backup suffix, so the suffix is attached.
sed -E -i.bak '/^hw\.lcd\.(width|height|density)[[:space:]]*=/d' "$config"
rm -f "$config.bak"
printf 'hw.lcd.width=1280\nhw.lcd.height=800\nhw.lcd.density=160\n' >>"$config"
